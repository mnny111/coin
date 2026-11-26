import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,VersionedTransaction,TransactionInstruction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,decodeBurnCheckedInstruction,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {Chain} from '../src/chain.js';
import {config} from '../src/config.js';
import {executeJob,tick} from '../src/worker.js';
const main=Keypair.generate(),nested=Keypair.generate(),parent=Keypair.generate().publicKey,child=Keypair.generate().publicKey;
function setup(t){const s=new Store(':memory:');t.after(()=>s.close());const c={...config({}),mint:Keypair.generate().publicKey.toBase58(),creator:main.publicKey.toBase58(),nestedFeeWallet:nested.publicKey.toBase58(),start:100};const e=new Engine(s,c);
 e.addPair({mint:parent.toBase58(),quote:c.mint,creator:'dev',name:'parent',symbol:'P',created:101,signature:'p'});e.addPair({mint:child.toBase58(),quote:parent.toBase58(),creator:'dev',name:'nested',symbol:'N',created:102,signature:'n'});return {s,c,e};}
function record(f,id='fee',amount='101',time=110){f.e.recordNestedFee({id,mint:child.toBase58(),recipient:f.c.nestedFeeWallet,quote:parent.toBase58(),amount,signature:id,time});}
function chainFor(f){const chain=new Chain({...f.c,rpc:'http://127.0.0.1:8899'});chain.signer=main;chain.nestedSigner=nested;chain.c.live=true;chain.pairState=async mint=>{assert.ok(mint.equals(parent));return {tokenProgram:TOKEN_PROGRAM_ID,mint:{decimals:6}};};return chain;}

test('each verified receipt creates exactly one full parent burn; main 70/30 accounting stays separate',t=>{
 const f=setup(t);f.e.addFee({id:'main',amount:'1000',time:105,signature:'main'});record(f);record(f);record(f,'later','200',200);
 f.e.planNestedBurns(120);f.e.planNestedBurns(120);const jobs=f.s.all("SELECT * FROM jobs WHERE kind='nested_burn'");assert.equal(jobs.length,1);assert.equal(jobs[0].amount,'101');assert.equal(jobs[0].recipient,parent.toBase58());
 assert.equal(f.e.totals().availableBuyback,700n);assert.equal(f.e.totals().availableRewards,300n);assert.deepEqual(f.e.totals().nestedBurns,{});
 f.s.run("UPDATE jobs SET status='failed'");f.e.planNestedBurns(120);assert.equal(f.s.all('SELECT * FROM jobs').length,1);
 f.s.run("UPDATE jobs SET status='confirmed'");assert.equal(f.e.totals().nestedBurns[parent.toBase58()],'101');f.e.planNestedBurns(200);assert.equal(f.s.all('SELECT * FROM jobs').length,2);
});
test('no receipt means no burn; other fee wallets cannot fund obligations',t=>{const f=setup(t);f.e.planNestedBurns(1000);assert.equal(f.s.all('SELECT * FROM jobs').length,0);record(f);f.c.nestedFeeWallet=Keypair.generate().publicKey.toBase58();f.e.planNestedBurns(1000);assert.equal(f.s.all('SELECT * FROM jobs').length,0);});
test('burn instruction uses the nested signer and exact receipt amount with no swap',async t=>{
 const f=setup(t);record(f);f.e.planNestedBurns(120);const job=f.s.get('SELECT * FROM jobs'),chain=chainFor(f),built=await chain.instructions(job);assert.equal(built.instructions.length,1);
 const burn=decodeBurnCheckedInstruction(built.instructions[0]);assert.ok(burn.keys.mint.pubkey.equals(parent));assert.ok(burn.keys.owner.pubkey.equals(nested.publicKey));assert.ok(burn.keys.account.pubkey.equals(getAssociatedTokenAddressSync(parent,nested.publicKey)));assert.equal(burn.data.amount,101n);assert.equal(built.details.burned,'101');assert.equal(built.details.receiptId,'fee');
 chain.c.nestedFeeWallet=main.publicKey.toBase58();await assert.rejects(chain.instructions(job),/does not match/);
});
test('nested burn preparation signs with nested wallet, reserves SOL only for gas and simulates',async t=>{
 const f=setup(t);record(f,'fee','9007199254740993');f.e.planNestedBurns(120);const chain=chainFor(f),job=f.s.get('SELECT * FROM jobs');let simulated=false;
 chain.connection={getBalance:async address=>{assert.ok(address.equals(nested.publicKey));return 50000000;},getLatestBlockhash:async()=>({blockhash:parent.toBase58(),lastValidBlockHeight:200}),simulateTransaction:async tx=>{assert.ok(tx.message.staticAccountKeys[0].equals(nested.publicKey));simulated=true;return {value:{err:null}};}};
 const result=await chain.prepare(job);assert.ok(simulated);const tx=VersionedTransaction.deserialize(Buffer.from(result.wire,'base64'));const ix=tx.message.compiledInstructions[2];const instruction=new TransactionInstruction({programId:tx.message.staticAccountKeys[ix.programIdIndex],data:Buffer.from(ix.data),keys:ix.accountKeyIndexes.map(i=>({pubkey:tx.message.staticAccountKeys[i],isSigner:tx.message.isAccountSigner(i),isWritable:tx.message.isAccountWritable(i)}))});assert.equal(decodeBurnCheckedInstruction(instruction).data.amount,9007199254740993n);
});
test('burn receipt reconciliation uses nested wallet balances and rejects an incorrect debit',async t=>{
 const f=setup(t);record(f);f.e.planNestedBurns(120);const chain=chainFor(f),job=f.s.get('SELECT * FROM jobs');job.details=JSON.stringify((await chain.instructions(job)).details);
 const row=(owner,amount)=>({owner,mint:parent.toBase58(),uiTokenAmount:{amount}});const tx={meta:{err:null,preTokenBalances:[row(f.c.nestedFeeWallet,'1001'),row(f.c.creator,'500')],postTokenBalances:[row(f.c.nestedFeeWallet,'900'),row(f.c.creator,'500')]}};chain.connection={getTransaction:async()=>tx};assert.equal((await chain.receipt(job)).details.burned,'101');tx.meta.postTokenBalances[0].uiTokenAmount.amount='901';await assert.rejects(chain.receipt(job),/cannot be reconciled/);
});
test('timeout retries reuse the same signed burn; confirmed receipt is never planned again',async t=>{
 const f=setup(t);record(f);f.e.planNestedBurns(120);let prepares=0,sends=0;const chain={prepare:async job=>{prepares++;return {wire:'same',signature:'sig',expiry:200,details:{...JSON.parse(job.details),burned:job.amount}};},status:async()=>null,connection:{getBlockHeight:async()=>100},send:async()=>{sends++;throw new Error('timeout');},receipt:async()=>({details:{burned:'101'}})};
 for(let i=0;i<2;i++)await assert.rejects(executeJob(f.s,chain,f.s.get('SELECT * FROM jobs')),/timeout/);assert.equal(prepares,1);assert.equal(sends,2);chain.status=async()=>({confirmationStatus:'finalized',err:null});await executeJob(f.s,chain,f.s.get('SELECT * FROM jobs'));f.e.planNestedBurns(120);assert.equal(f.s.all('SELECT * FROM jobs').length,1);assert.equal(f.e.totals().nestedBurns[parent.toBase58()],'101');
});
test('observe mode plans burns without signing or collecting',async t=>{const f=setup(t);record(f);await tick(f.e,{index:async()=>120,prepare:()=>assert.fail('no signing')});assert.equal(f.s.get('SELECT status FROM jobs').status,'planned');});
test('absent nested signer leaves burn queued without blocking a main job',async t=>{
 const f=setup(t);f.c.live=true;record(f);f.s.setting('lastCollect',Math.floor(Date.now()/1000));f.e.job('main-job','buyback','1');let selected;
 await tick(f.e,{index:async()=>120,prepare:async job=>{selected=job.id;throw new Error('fixture');}}).catch(()=>{});assert.equal(selected,'main-job');assert.equal(f.s.get("SELECT status FROM jobs WHERE kind='nested_burn'").status,'planned');
});
test('automatic collection is deduplicated per coin and interval and requires verified share',async t=>{
 const f=setup(t);f.c.live=true;const now=Math.floor(Date.now()/1000);f.s.setting('lastCollect',now);f.s.run('INSERT INTO nested_verification VALUES (?,?,1,?)',child.toBase58(),f.c.nestedFeeWallet,now);let checks=0;
 const chain={nestedSigner:nested,index:async()=>120,pendingNestedFees:async()=>{checks++;return 10n;},prepare:async()=>{throw new Error('fixture');}};
 await assert.rejects(tick(f.e,chain),/fixture/);await tick(f.e,chain);assert.equal(checks,1);assert.equal(f.s.all("SELECT * FROM jobs WHERE kind='nested_collect'").length,1);
});
