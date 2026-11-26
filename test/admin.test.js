import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import {Store} from '../src/store.js';
import {Engine} from '../src/engine.js';
import {config} from '../src/config.js';
import {createApi} from '../src/server.js';
const token='test-admin-key-'.repeat(4),mint=()=>Keypair.generate().publicKey.toBase58();
async function setup(t,options={}){const store=new Store(':memory:');const c={...config({}),adminPasscode:token,...options};const engine=new Engine(store,c),server=createApi(engine);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();});return {store,c,engine,root:`http://127.0.0.1:${server.address().port}`};}
const save=(root,value,key=token)=>fetch(root+'/admin/config',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
test('admin page is public but configuration reads and writes require the server passcode',async t=>{
 const f=await setup(t);assert.equal((await fetch(f.root+'/admin')).status,200);assert.equal((await fetch(f.root+'/admin/config')).status,401);assert.equal((await save(f.root,{mint:mint()},'wrong')).status,401);assert.equal(f.store.setting('configuredMint'),null);
 const html=await (await fetch(f.root+'/admin')).text();assert.match(html,/Coin mint address/);assert.doesNotMatch(html,new RegExp(token));
});
test('saving a valid mint persists, updates public config, and survives loading configuration again',async t=>{
 const f=await setup(t),address=mint();const response=await save(f.root,{mint:address});assert.equal(response.status,200);assert.equal(f.store.setting('configuredMint'),address);assert.equal((await (await fetch(f.root+'/api/config')).json()).mint,address);
 assert.equal(config({COIN_MINT:mint()},f.store.setting('configuredMint')).mint,address);assert.equal(f.c.live,false);assert.equal(f.store.all('SELECT * FROM audit').length,1);
});
test('admin rejects invalid mint and fields outside the requested configuration scope',async t=>{
 const f=await setup(t);for(const body of [{mint:'bad'},{mint:''},{mint:mint(),live:true},{mint:null}])assert.equal((await save(f.root,body)).status,400);assert.equal(f.store.setting('configuredMint'),null);
});
test('a bound accounting policy cannot be switched to another mint',async t=>{
 const original=mint(),f=await setup(t,{mint:original,creator:mint(),start:100});assert.equal((await save(f.root,{mint:mint()})).status,409);assert.equal(f.c.mint,original);assert.equal((await save(f.root,{mint:original})).status,200);
});
test('active worker lease prevents editing an unbound mint',async t=>{
 const f=await setup(t);f.store.acquire('worker',Math.floor(Date.now()/1000));assert.equal((await save(f.root,{mint:mint()})).status,409);assert.equal(f.store.setting('configuredMint'),null);
});
test('saved mint participates in live configuration validation',()=>{
 const address=mint();const c=config({EXECUTION_MODE:'live',SOLANA_RPC_URL:'http://127.0.0.1:8899',CREATOR_ADDRESS:mint(),START_TIME:'100',SIGNER_KEY_FILE:'secret.json',DEDICATED_CREATOR_CONFIRMED:'true'},address);assert.equal(c.mint,address);
});

test('website can start before live worker credentials and mint are configured',()=>{
 const c=config({EXECUTION_MODE:'live'},undefined,{requireLiveConfig:false});
 assert.equal(c.live,true);assert.equal(c.mint,null);
 assert.throws(()=>config({EXECUTION_MODE:'live'}),/Live mode requires/);
});
