import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {config} from '../src/config.js';

test('nested launches are recorded privately and never enter direct-pair buyback rankings',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const engine=new Engine(store,{...config({}),mint:'main'});
 const launch=(mint,quote)=>engine.addPair({mint,quote,creator:'dev',name:mint,symbol:mint,created:100,signature:mint});
 assert.equal(launch('parent','main'),true);assert.equal(launch('child','parent'),true);assert.equal(launch('child','parent'),false);
 assert.equal(store.get('SELECT parent_mint FROM nested_pairs').parent_mint,'parent');
 assert.equal(store.get('SELECT COUNT(*) AS n FROM pairs').n,1);
 assert.equal(engine.addTrade({id:'t',mint:'child',amount:'100',time:101,trader:'user',signature:'t'}),false);
 assert.deepEqual(engine.leaderboard(0),[]);
 assert.equal(launch('unrelated','unknown'),false);assert.equal(launch('deeper','child'),false);
});
import {Keypair,PublicKey} from '@solana/web3.js';
import {BN} from '@coral-xyz/anchor';
import {PUMP_SDK,PUMP_FEE_PROGRAM_ID,PUMP_PROGRAM_ID,feeSharingConfigPda} from '@pump-fun/pump-sdk';
import {Chain} from '../src/chain.js';
import {fullFeeShare,verifyNestedPair} from '../src/nested-listing.js';
import {createApi} from '../src/server.js';
const address=()=>Keypair.generate().publicKey.toBase58();
function nestedSetup(t){
 const s=new Store(':memory:');t.after(()=>s.close());const c={...config({}),mint:address(),creator:address(),nestedFeeWallet:address()};const e=new Engine(s,c),parent=address(),child=address();
 for(const [mint,quote] of [[parent,c.mint],[child,parent]])e.addPair({mint,quote,creator:address(),name:mint===child?'Nested':'Parent',symbol:'X',created:100,signature:mint});
 return {s,e,c,parent,child};
}
function proof(f,time=Math.floor(Date.now()/1000)){f.s.run('INSERT OR REPLACE INTO nested_verification VALUES (?,?,1,?)',f.child,f.c.nestedFeeWallet,time);}
function receipt(f,overrides={}){return f.e.recordNestedFee({id:'distribution',mint:f.child,recipient:f.c.nestedFeeWallet,quote:f.parent,amount:'10',signature:'sig',time:101,...overrides});}

test('ongoing share must be exactly 100% to one designated recipient',()=>{
 const wallet=address();assert.equal(fullFeeShare([{address:wallet,shareBps:10000}],wallet),true);
 for(const shares of [[],[{address:wallet,shareBps:9999}],[{address:address(),shareBps:10000}],[{address:wallet,shareBps:5000},{address:address(),shareBps:5000}]])assert.equal(fullFeeShare(shares,wallet),false);
 assert.equal(fullFeeShare([{address:wallet,shareBps:10000}],null),false);
});
test('listing requires a receipt AND fresh ongoing verification; stale, removed or changed wallet hides it',t=>{
 const f=nestedSetup(t);proof(f);assert.equal(f.e.listedPairs().length,1);assert.equal(receipt(f),true);assert.equal(receipt(f),false);assert.equal(f.e.listedPairs().length,2);
 proof(f,Math.floor(Date.now()/1000)-301);assert.equal(f.e.listedPairs().length,1);proof(f);f.s.run('UPDATE nested_verification SET valid=0');assert.equal(f.e.listedPairs().length,1);
 proof(f);f.c.nestedFeeWallet=address();assert.equal(f.e.listedPairs().length,1);f.c.nestedFeeWallet=null;assert.equal(f.e.listedPairs().length,1);
});
test('wrong recipient, zero amount, unknown mint or wrong quote cannot qualify',t=>{
 const f=nestedSetup(t);for(const change of [{recipient:address()},{amount:'0'},{mint:address()},{quote:address()}])assert.equal(receipt(f,change),false);
 assert.equal(f.s.get('SELECT COUNT(*) AS n FROM nested_fee_receipts').n,0);
});
test('ordinary transfers do not count; authenticated distribution with full share does',async t=>{
 const f=nestedSetup(t),chain=new Chain({...f.c,rpc:'http://127.0.0.1:8899'});let events=[];chain.decodeEvents=()=>events;
 const tx={blockTime:101,meta:{err:null}};await chain.ingest(tx,'transfer',f.e);assert.equal(f.s.get('SELECT COUNT(*) AS n FROM nested_fee_receipts').n,0);
 const data={mint:new PublicKey(f.child),quoteMint:new PublicKey(f.parent),sharingConfig:feeSharingConfigPda(new PublicKey(f.child)),distributed:new BN(10),shareholders:[{address:new PublicKey(f.c.nestedFeeWallet),shareBps:10000}]};
 events=[{id:'event',name:'distributecreatorfeesevent',data}];await chain.ingest(tx,'fee',f.e);assert.equal(f.s.get('SELECT COUNT(*) AS n FROM nested_fee_receipts').n,1);
 data.shareholders[0].shareBps=9000;await chain.ingest(tx,'partial',f.e);assert.equal(f.s.get('SELECT COUNT(*) AS n FROM nested_fee_receipts').n,1);
});
test('verification checks canonical accounts and owners, current allocation and curve routing',async t=>{
 const f=nestedSetup(t),mint=new PublicKey(f.child),parent=new PublicKey(f.parent),sharing=feeSharingConfigPda(mint);
 const configState={mint,shareholders:[{address:new PublicKey(f.c.nestedFeeWallet),shareBps:10000}]};const curve={creator:sharing,quoteMint:parent,complete:false};
 t.mock.method(PUMP_SDK,'decodeSharingConfig',()=>configState);t.mock.method(PUMP_SDK,'decodeBondingCurve',()=>curve);
 const infos=[{owner:PUMP_FEE_PROGRAM_ID},{owner:PUMP_PROGRAM_ID},null];
 const chain={connection:{getMultipleAccountsInfo:async(keys,commitment)=>{assert.ok(keys[0].equals(sharing));assert.equal(commitment,'finalized');return infos;}}};
 const pair={mint:f.child,parent_mint:f.parent};assert.equal(await verifyNestedPair(chain,pair,f.c.nestedFeeWallet),true);
 configState.shareholders[0].shareBps=9999;assert.equal(await verifyNestedPair(chain,pair,f.c.nestedFeeWallet),false);configState.shareholders[0].shareBps=10000;
 curve.creator=PublicKey.default;assert.equal(await verifyNestedPair(chain,pair,f.c.nestedFeeWallet),false);curve.creator=sharing;
 infos[0].owner=PUMP_PROGRAM_ID;assert.equal(await verifyNestedPair(chain,pair,f.c.nestedFeeWallet),false);infos[0].owner=PUMP_FEE_PROGRAM_ID;
 curve.complete=true;assert.equal(await verifyNestedPair(chain,pair,f.c.nestedFeeWallet),false);
});
test('public search and count expose only verified fee-sharing nested coins',async t=>{
 const f=nestedSetup(t),server=createApi(f.e);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const root=`http://127.0.0.1:${server.address().port}`;
 const get=async path=>(await fetch(root+path)).json();assert.equal((await get('/api/pairs?q=Nested')).total,0);
 proof(f);receipt(f);assert.equal((await get('/api/pairs?q=Nested')).items[0].depth,2);assert.equal((await get('/api/stats')).pairs,2);
 f.s.run('UPDATE nested_verification SET valid=0');assert.equal((await get('/api/pairs?q=Nested')).total,0);assert.equal((await get('/api/stats')).pairs,1);
 assert.equal((await get('/api/config')).nestedListing.requiredShareBps,10000);
});
