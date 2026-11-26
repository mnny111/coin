import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine,splitFees,proportional } from '../src/engine.js';
import { config } from '../src/config.js';
import { createApi } from '../src/server.js';
import { executeJob,tick } from '../src/worker.js';
import { Chain } from '../src/chain.js';
import { Keypair,PublicKey,VersionedTransaction,SystemInstruction,TransactionInstruction,Connection } from '@solana/web3.js';
import { createServer } from 'node:http';
import { BN } from '@coral-xyz/anchor';
import { NATIVE_MINT } from '@solana/spl-token';
import bs58 from 'bs58';

const mint=Keypair.generate().publicKey.toBase58(),creator=Keypair.generate().publicKey.toBase58();
const settings=()=>({...config({}),mint,creator,start:10800,roundSeconds:10800,minBuyback:'1',maxBuyback:'1000'});
function setup(t,c=settings(),path=':memory:'){const s=new Store(path);t.after(()=>s.close());return new Engine(s,c);}
function pair(e,name,created=10801){e.addPair({mint:name,quote:mint,creator:`dev-${name}`,name,symbol:name,created,signature:`create-${name}`});}
function trade(e,name,amount,time=10810,id=`trade-${name}`){e.addTrade({id,mint:name,amount,time,trader:'wallet',signature:id});}
function fee(e,amount='1000',time=10820,id='fee'){e.addFee({id,amount,time,signature:id});}

test('exact integer fee allocation conserves arbitrary large amounts and dust',()=>{
  for(const amount of ['0','1','9','101','9007199254740993123456789']){const s=splitFees(amount);assert.equal(s.buyback+s.rewards+s.treasury,BigInt(amount));assert.equal(s.treasury,0n);}
  assert.deepEqual(splitFees('1000'),{buyback:700n,rewards:300n,treasury:0n});
  assert.throws(()=>splitFees('-1'));assert.throws(()=>splitFees('1.2'));assert.throws(()=>splitFees('10',8000,3000));
  assert.deepEqual(proportional('11',[50,30,20]),[6n,3n,2n]);
});
test('unconfigured API database can be configured later',t=>{const e=setup(t,config({}));assert.equal(e.s.setting('policy'),null);new Engine(e.s,settings());assert.ok(e.s.setting('policy'));});
test('policy changes cannot silently reinterpret historical money',t=>{const e=setup(t);assert.throws(()=>new Engine(e.s,{...e.c,buybackBps:6000}),/policy changed/);});
test('deduplicates receipts and trades and rejects unrelated quote mints',t=>{
  const e=setup(t);pair(e,'a');trade(e,'a','90071992547409931234');trade(e,'a','90071992547409931234');fee(e);fee(e);
  assert.equal(e.totals().collected,1000n);assert.equal(e.leaderboard(10800)[0].volume,90071992547409931234n);
  assert.equal(e.addPair({mint:'x',quote:'wrong'}),false);
});
test('rounds include all active pairs, weight by volume, conserve pot and settle once',t=>{
  const e=setup(t);pair(e,'old',10000);trade(e,'old','1000');
  ['a','b','c','d'].forEach((n,i)=>{pair(e,n);trade(e,n,String(400-i*100));});
  fee(e);e.settle(21720);e.settle(21720);
  const jobs=e.s.all("SELECT * FROM jobs WHERE kind='pair_funding' ORDER BY id");
  assert.equal(jobs.length,5);assert.deepEqual(jobs.map(j=>j.amount),['150','60','45','30','15']);
  assert.deepEqual(jobs.map(j=>j.recipient),['old','a','b','c','d']);assert.equal(e.totals().availableRewards,0n);
});
test('no eligible pairs rolls pot forward; one winner gets the full pot',t=>{
  const e=setup(t);fee(e);e.settle(21720);assert.equal(e.s.get('SELECT pot FROM rounds').pot,'0');
  pair(e,'a',21601);trade(e,'a','1',21605);e.settle(32520);
  assert.equal(e.s.get("SELECT amount FROM jobs WHERE kind='pair_funding'").amount,'300');
});
test('fees from a later round cannot be spent by an earlier round',t=>{
  const e=setup(t);pair(e,'a');trade(e,'a','1');fee(e,'1000',21601);e.settle(21720);
  assert.equal(e.s.all('SELECT * FROM jobs').length,0);assert.equal(e.totals().availableRewards,300n);
});
test('round boundary excludes launches and trades at its exact end',t=>{
  const e=setup(t);pair(e,'a');trade(e,'a','1',21600);pair(e,'b',21600);trade(e,'b','100',21600);fee(e);e.settle(21720);
  assert.equal(e.s.all('SELECT * FROM jobs').length,0);
});
test('incomplete watermark never closes a round',t=>{const e=setup(t);fee(e);e.settle(21719);assert.equal(e.s.all('SELECT * FROM rounds').length,0);});
test('ties resolve deterministically by launch time then mint',t=>{const e=setup(t);pair(e,'b');pair(e,'a');trade(e,'a','10');trade(e,'b','10');assert.deepEqual(e.leaderboard(10800).map(p=>p.mint),['a','b']);});
test('buyback reservations prevent overspend and release confirmed unused budget',t=>{
  const e=setup(t);fee(e);e.planBuyback();e.planBuyback();assert.equal(e.s.all('SELECT * FROM jobs').length,1);assert.equal(e.totals().availableBuyback,0n);
  e.s.run("UPDATE jobs SET status='confirmed',details=?",JSON.stringify({burned:'100',refund:'50'}));
  assert.equal(e.totals().availableBuyback,50n);e.planBuyback();assert.equal(e.s.all('SELECT * FROM jobs').length,2);assert.equal(e.totals().availableBuyback,0n);
});
test('failed jobs keep their reservation',t=>{const e=setup(t);fee(e);e.planBuyback();e.s.run("UPDATE jobs SET status='failed'");e.planBuyback();assert.equal(e.totals().availableBuyback,0n);assert.equal(e.s.all('SELECT * FROM jobs').length,1);});
test('transaction rollback and exclusive worker leases',t=>{
  const e=setup(t);assert.throws(()=>e.s.transaction(()=>{fee(e);throw new Error('rollback');}));assert.equal(e.totals().collected,0n);
  assert.equal(e.s.acquire('a',100,60),true);assert.equal(e.s.acquire('b',110,60),false);assert.equal(e.s.acquire('b',161,60),true);
});
test('persistent ledger survives reopen',()=>{
  const dir=mkdtempSync(join(tmpdir(),'coin-test-'));try{let s=new Store(join(dir,'coin.db'));let e=new Engine(s,settings());fee(e);s.close();s=new Store(join(dir,'coin.db'));e=new Engine(s,settings());fee(e);assert.equal(e.totals().collected,1000n);s.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
function fakeChain(overrides={}) {
  return {prepare:async()=>({wire:'signed-bytes',signature:'same-signature',expiry:200,details:{}}),status:async()=>null,send:async()=>{},receipt:async()=>({details:{}}),connection:{getBlockHeight:async()=>100},...overrides};
}
test('broadcast timeout preserves signed bytes and retry never signs again',async t=>{
  const e=setup(t);e.job('r','reward','10','dev');let signed=0,sent=[];
  const chain=fakeChain({prepare:async()=>{signed++;return {wire:'bytes',signature:'signature',expiry:200,details:{}};},send:async wire=>{sent.push(wire);throw new Error('timeout');}});
  await assert.rejects(executeJob(e.s,chain,e.s.get('SELECT * FROM jobs')),/timeout/);
  await assert.rejects(executeJob(e.s,chain,e.s.get('SELECT * FROM jobs')),/timeout/);
  assert.equal(signed,1);assert.deepEqual(sent,['bytes','bytes']);assert.equal(e.s.get('SELECT status FROM jobs').status,'prepared');
});
test('finalized success confirms once and hides signed bytes',async t=>{
  const e=setup(t);e.job('r','reward','10','dev');await executeJob(e.s,fakeChain(),e.s.get('SELECT * FROM jobs'));
  await executeJob(e.s,fakeChain({status:async()=>({confirmationStatus:'finalized',err:null})}),e.s.get('SELECT * FROM jobs'));
  assert.equal(e.s.get('SELECT status FROM jobs').status,'confirmed');assert.equal(e.s.get('SELECT wire FROM jobs').wire,null);
});
test('known finalized failure cannot be counted as paid',async t=>{
  const e=setup(t);e.job('r','reward','10','dev');await executeJob(e.s,fakeChain(),e.s.get('SELECT * FROM jobs'));
  await executeJob(e.s,fakeChain({status:async()=>({confirmationStatus:'finalized',err:{InstructionError:[0,'error']}})}),e.s.get('SELECT * FROM jobs'));
  assert.equal(e.s.get('SELECT status FROM jobs').status,'failed');assert.equal(e.totals().pairFunded,0n);
});
test('expired transaction is rebuilt only when absent after finalized expiry',async t=>{
  const e=setup(t);e.job('r','reward','10','dev');await executeJob(e.s,fakeChain(),e.s.get('SELECT * FROM jobs'));
  await executeJob(e.s,fakeChain({connection:{getBlockHeight:async()=>201}}),e.s.get('SELECT * FROM jobs'));
  assert.equal(e.s.get('SELECT status FROM jobs').status,'planned');assert.equal(e.s.get('SELECT signature FROM jobs').signature,null);
});
test('confirmed-but-not-finalized signature is not replaced after expiry',async t=>{
  const e=setup(t);e.job('r','reward','10','dev');await executeJob(e.s,fakeChain(),e.s.get('SELECT * FROM jobs'));
  await executeJob(e.s,fakeChain({status:async()=>({confirmationStatus:'confirmed',err:null}),connection:{getBlockHeight:async()=>201}}),e.s.get('SELECT * FROM jobs'));
  assert.equal(e.s.get('SELECT status FROM jobs').status,'prepared');
});
test('observe mode never prepares or sends transactions',async t=>{
  const e=setup(t);pair(e,'a');trade(e,'a','100');fee(e);
  await tick(e,{index:async()=>21720,prepare:()=>assert.fail('must not sign'),send:()=>assert.fail('must not send')});
  assert.equal(e.s.all("SELECT * FROM jobs WHERE status!='planned'").length,0);
});
test('index failure prevents settlement and payment',async t=>{
  const e=setup(t,{...settings(),live:true});fee(e);
  await assert.rejects(tick(e,{index:async()=>{throw new Error('RPC unavailable');}}),/RPC unavailable/);
  assert.equal(e.s.all('SELECT * FROM rounds').length,0);
});
test('SDK CPI event decode authenticates program and preserves distinct event IDs',async()=>{
  const chain=new Chain({...settings(),rpc:'http://127.0.0.1:8899'}),program=chain.programs[0];
  const event=program.idl.events.find(e=>e.name==='collectCreatorFeeEvent');assert.ok(event);
  const payload=await program.coder.types.encode('collectCreatorFeeEvent',{timestamp:new BN(10820),creator:new PublicKey(creator),creatorFee:new BN(1000),quoteMint:NATIVE_MINT});
  const data=bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1d','hex'),Buffer.from(event.discriminator),payload]));
  const tx={transaction:{message:{getAccountKeys:()=>({get:()=>program.programId})}},meta:{err:null,innerInstructions:[{index:1,instructions:[{programIdIndex:0,data},{programIdIndex:0,data}]}],logMessages:[]}};
  const events=chain.decodeEvents(tx);assert.equal(events.length,2);assert.notEqual(events[0].id,events[1].id);assert.equal(events[0].data.creatorFee.toString(),'1000');
  tx.meta.err={InstructionError:[]};assert.equal(chain.decodeEvents(tx).length,0);
});
test('RPC history gaps do not advance scan cursor',async t=>{
  const e=setup(t),chain=new Chain({...settings(),rpc:'http://127.0.0.1:8899'});
  chain.connection={getSignaturesForAddress:async()=>[{signature:'missing',blockTime:10820,err:null}],getTransaction:async()=>null};
  await assert.rejects(chain.scan(mint,e),/history unavailable/);assert.equal(e.s.setting(`cursor:${mint}`),null);
});
test('public API serializes bigints, hides secrets and protects admin actions',async t=>{
  const e=setup(t,{...settings(),adminToken:'x'.repeat(40)});fee(e);const server=createApi(e);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const root=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(root+'/api/stats')).json()).collected,'1000');
  assert.equal((await fetch(root+'/admin/status')).status,401);
  assert.equal((await fetch(root+'/admin/pause',{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(40)}`},body:JSON.stringify({paused:true})})).status,200);
  assert.equal(e.s.setting('paused'),'true');assert.equal((await fetch(root+'/api/pairs?offset=-0.5')).status,200);
  const cfg=await (await fetch(root+'/api/config')).json();assert.equal(cfg.adminToken,undefined);assert.equal(cfg.rpc,undefined);
  assert.equal((await fetch(root+'/api/pairs?offset=1.5')).status,400);
});
test('live execution requires explicit configuration and dedicated creator',()=>{assert.throws(()=>config({EXECUTION_MODE:'live'}),/Live mode requires/);assert.throws(()=>config({SLIPPAGE_BPS:'1001'}),/Invalid/);});

test('legacy developer payments are rejected',async()=>{
 const chain=new Chain({...settings(),rpc:'http://127.0.0.1:8899'});chain.signer=Keypair.generate();
 await assert.rejects(chain.instructions({kind:'reward',amount:'1',recipient:creator}),/developer payouts are disabled/);
});

test('patched JSON-RPC transport works against a real HTTP fixture',async t=>{
  const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const b=JSON.parse(raw);assert.equal(b.method,'getBalance');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:b.id,result:{context:{slot:123},value:456}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const connection=new Connection(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await connection.getBalance(new PublicKey(mint)),456);
});

test('frontend clean routes serve HTML, assets have correct types, and private files stay inaccessible',async t=>{
  const e=setup(t),server=createApi(e);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const root=`http://127.0.0.1:${server.address().port}`;
  for(const route of ['/','/rewards','/activity','/about']){const r=await fetch(root+route);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/text\/html/);assert.match(await r.text(),/id="main"/);assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);}
  assert.match((await fetch(root+'/app.js')).headers.get('content-type'),/javascript/);
  assert.match((await fetch(root+'/styles.css')).headers.get('content-type'),/text\/css/);
  for(const route of ['/.env','/src/config.js','/data/coin.sqlite','/package.json'])assert.equal((await fetch(root+route)).status,404);
});
test('pair search matches names and treats SQL wildcard input literally',async t=>{
  const e=setup(t);pair(e,'Alpha');pair(e,'Percent%');pair(e,'Under_score');
  const server=createApi(e);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const root=`http://127.0.0.1:${server.address().port}`;
  for(const [query,name] of [['alpha','Alpha'],['%','Percent%'],['_','Under_score']]){const result=await (await fetch(root+'/api/pairs?q='+encodeURIComponent(query))).json();assert.equal(result.total,1);assert.equal(result.items[0].name,name);}
});
