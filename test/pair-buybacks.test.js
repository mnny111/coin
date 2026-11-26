import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { config } from '../src/config.js';
import { Chain } from '../src/chain.js';
import { executeJob,tick } from '../src/worker.js';
import { Keypair,PublicKey,VersionedTransaction,TransactionInstruction,SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID,decodeBurnCheckedInstruction,getAssociatedTokenAddressSync } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
const mint=Keypair.generate().publicKey.toBase58(),creator=Keypair.generate().publicKey.toBase58(),target=Keypair.generate().publicKey.toBase58();
function setup(t){const s=new Store(':memory:');t.after(()=>s.close());return new Engine(s,{...config({}),mint,creator,start:10800,roundSeconds:10800,minBuyback:'1'});}
const receiptChain=details=>({prepare:async()=>({signature:'sig',wire:'wire',expiry:200,details:{}}),status:async()=>({confirmationStatus:'finalized',err:null}),receipt:async()=>({details})});

test('operator trades never increase pair weight; old pairs qualify and inactive pairs do not',t=>{
 const e=setup(t);for(const name of ['old','quiet','operator'])e.addPair({mint:name,quote:mint,creator:'dev',name,symbol:name,created:10000,signature:name});
 e.addTrade({id:'a',mint:'old',time:10810,amount:'10',trader:'external',signature:'a'});
 e.addTrade({id:'b',mint:'operator',time:10810,amount:'99999',trader:creator,signature:'b'});
 assert.deepEqual(e.leaderboard(10800).map(p=>p.mint),['old']);
});
test('confirmed funding creates exactly one burn obligation and consumes carried Coin credit atomically',async t=>{
 const e=setup(t);e.s.run('INSERT INTO pair_credits VALUES (?,?)',target,'7');e.job('pair:1','pair_funding','100',target,10800);
 const chain=receiptChain({acquired:'1000',spent:'99',refund:'1'});
 await executeJob(e.s,chain,e.s.get("SELECT * FROM jobs WHERE id='pair:1'"));
 await executeJob(e.s,chain,e.s.get("SELECT * FROM jobs WHERE id='pair:1'"));
 const burn=e.s.get("SELECT * FROM jobs WHERE kind='pair_burn'");assert.equal(burn.amount,'1007');assert.equal(burn.recipient,target);
 assert.equal(e.s.get('SELECT amount FROM pair_credits').amount,'0');assert.equal(e.s.all('SELECT * FROM jobs').length,2);
 await executeJob(e.s,receiptChain({burned:'40',quoteSpent:'1000',quoteRefund:'7'}),burn);
 await executeJob(e.s,chain,e.s.get('SELECT * FROM jobs WHERE id=?',burn.id));
 assert.equal(e.s.get('SELECT amount FROM pair_credits').amount,'7');assert.equal(e.totals().pairBurns,1);assert.equal(e.totals().pairFunded,99n);
});
test('failed funding cannot create a burn and holds its allocation',async t=>{
 const e=setup(t);e.addFee({id:'fee',time:10801,amount:'1000',signature:'f'});e.job('pair:1','pair_funding','300',target,10800);
 const chain=receiptChain({});chain.status=async()=>({confirmationStatus:'finalized',err:'failed'});
 await executeJob(e.s,chain,e.s.get('SELECT * FROM jobs'));
 assert.equal(e.s.all("SELECT * FROM jobs WHERE kind='pair_burn'").length,0);assert.equal(e.totals().availableRewards,0n);assert.equal(e.totals().pairFunded,0n);
});
test('SOL refunds are carried forward only after funding confirmation time',t=>{
 const e=setup(t);e.addPair({mint:target,quote:mint,creator:'dev',name:'pair',symbol:'p',created:10000,signature:'p'});
 for(const time of [10810,21610,32410])e.addTrade({id:String(time),mint:target,time,amount:'1',trader:'user',signature:String(time)});
 e.addFee({id:'f',time:10801,amount:'1000',signature:'f'});e.settle(21720);
 e.s.run("UPDATE jobs SET status='confirmed',updated=32401,details=?",JSON.stringify({spent:'290',refund:'10',acquired:'100'}));
 e.settle(32520);assert.equal(e.s.all('SELECT * FROM jobs').length,1);
 e.settle(43320);assert.equal(e.s.all('SELECT * FROM jobs').length,2);assert.equal(e.s.get('SELECT amount FROM jobs WHERE round=32400').amount,'10');
});
test('preparation failure reserves its budget but allows other planned jobs next tick',async t=>{
 const e=setup(t);e.c.live=true;e.c.start=0;e.s.setting('lastCollect',Math.floor(Date.now()/1000));
 e.job('a','pair_burn','1',target);e.job('b','pair_burn','2',target);
 const chain={index:async()=>0,prepare:async()=>{throw new Error('illiquid');}};
 await assert.rejects(tick(e,chain),/illiquid/);assert.equal(e.s.get("SELECT status FROM jobs WHERE id='a'").status,'failed');
 await assert.rejects(tick(e,chain),/illiquid/);assert.equal(e.s.get("SELECT status FROM jobs WHERE id='b'").status,'failed');
});
test('paired purchase appends a burn for the exact bought mint and quantity',async()=>{
 const chain=new Chain({...config({}),mint,creator,rpc:'http://127.0.0.1:8899'});chain.signer=Keypair.generate();
 const state={tokenProgram:TOKEN_PROGRAM_ID,mint:{decimals:6}};chain.mainState=async()=>state;chain.pairState=async()=>state;
 chain.buy=async(base,quote,_,program,amount,user)=>{assert.equal(base.toBase58(),target);assert.equal(quote.toBase58(),mint);assert.equal(amount.toString(),'1234');assert.ok(user.equals(chain.signer.publicKey));return {base:new BN(42),instructions:[]};};
 const result=await chain.instructions({kind:'pair_burn',recipient:target,amount:'1234'});const burn=decodeBurnCheckedInstruction(result.instructions[0]);
 assert.equal(burn.keys.mint.pubkey.toBase58(),target);assert.equal(burn.data.amount,42n);assert.equal(burn.data.decimals,6);assert.equal(result.details.burned,'42');
});
test('pair receipt reconciles Coin debit and refuses retained purchased tokens',async()=>{
 const chain=new Chain({...config({}),mint,creator,rpc:'http://127.0.0.1:8899'});
 const row=(m,a)=>({mint:m,owner:creator,uiTokenAmount:{amount:a}});
 const tx={meta:{err:null,preTokenBalances:[row(mint,'1000'),row(target,'5')],postTokenBalances:[row(mint,'110'),row(target,'5')]}};
 chain.connection={getTransaction:async()=>tx};
 const job={kind:'pair_burn',recipient:target,amount:'900',signature:'s',details:JSON.stringify({burned:'42'})};
 assert.equal((await chain.receipt(job)).details.quoteRefund,'10');
 tx.meta.postTokenBalances[1]=row(target,'6');await assert.rejects(chain.receipt(job),/not fully burned/);
});
test('pair burn preparation uses SOL only for reserve, simulates and signs',async()=>{
 const signer=Keypair.generate(),chain=new Chain({...config({}),mint,creator,rpc:'http://127.0.0.1:8899'});chain.signer=signer;chain.c.live=true;
 chain.instructions=async()=>({instructions:[SystemProgram.transfer({fromPubkey:signer.publicKey,toPubkey:new PublicKey(target),lamports:1})],details:{}});
 chain.connection={getBalance:async()=>50000000,getLatestBlockhash:async()=>({blockhash:PublicKey.default.toBase58(),lastValidBlockHeight:100}),simulateTransaction:async()=>({value:{err:null}})};
 const result=await chain.prepare({kind:'pair_burn',amount:'9007199254740993',recipient:target});assert.ok(VersionedTransaction.deserialize(Buffer.from(result.wire,'base64')).signatures[0]);
 chain.connection.simulateTransaction=async()=>({value:{err:'bad'}});await assert.rejects(chain.prepare({kind:'pair_burn',amount:'1',recipient:target}),/Simulation rejected/);
});
test('large pair allocations are split into capped funding jobs without losing funds',t=>{
 const e=setup(t);e.c.maxBuyback='100';e.addPair({mint:target,quote:mint,creator:'dev',name:'p',symbol:'p',created:10000,signature:'p'});
 e.addTrade({id:'t',mint:target,time:10810,amount:'1',trader:'user',signature:'t'});e.addFee({id:'f',time:10801,amount:'1001',signature:'f'});e.settle(21720);
 const amounts=e.s.all("SELECT amount FROM jobs WHERE kind='pair_funding' ORDER BY id").map(j=>BigInt(j.amount));assert.deepEqual(amounts,[100n,100n,100n,1n]);assert.equal(e.totals().availableRewards,0n);
});
test('default paired buyback rounds settle every five minutes after indexing delay',t=>{
 const e=setup(t);e.c.roundSeconds=config({}).roundSeconds;assert.equal(e.c.roundSeconds,300);
 e.addPair({mint:target,quote:mint,creator:'dev',name:'p',symbol:'p',created:10000,signature:'p'});
 for(const time of [10810,11110]){e.addTrade({id:String(time),mint:target,time,amount:'1',trader:'user',signature:String(time)});e.addFee({id:'f'+time,time,amount:'1000',signature:'f'+time});}
 e.settle(11219);assert.equal(e.s.all('SELECT * FROM rounds').length,0);
 e.settle(11220);assert.equal(e.s.all('SELECT * FROM rounds').length,1);
 e.settle(11520);assert.deepEqual(e.s.all('SELECT start,end,pot FROM rounds ORDER BY start').map(r=>[r.start,r.end,r.pot]),[[10800,11100,'300'],[11100,11400,'300']]);
});
