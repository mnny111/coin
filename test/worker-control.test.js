import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Keypair} from '@solana/web3.js';
import {Store} from '../src/store.js';
import {workerControl} from '../src/worker-control.js';
import {createApi} from '../src/server.js';
import {Engine} from '../src/engine.js';
import {config} from '../src/config.js';
const address=()=>Keypair.generate().publicKey.toBase58();
test('worker start validates configuration, deduplicates, and permits retry after exit',()=>{
 const s=new Store(':memory:');let calls=0;const child=new EventEmitter();child.kill=()=>{};
 const env={SOLANA_RPC_URL:'http://localhost:8899',CREATOR_ADDRESS:address()};
 const control=workerControl(s,env,()=>{calls++;return child;});
 try{
 assert.throws(()=>control.start(),/Save the Coin mint/);assert.equal(calls,0);
 s.setting('configuredMint',address());assert.equal(control.start().started,true);assert.equal(control.status().processRunning,true);
 assert.equal(control.start().alreadyRunning,true);assert.equal(calls,1);
 child.emit('close',1);assert.equal(control.status().processRunning,false);assert.match(control.status().error,/Worker stopped/);
 assert.equal(control.start().started,true);assert.equal(calls,2);
 }finally{s.close();}
});
test('worker control respects an existing lease and live configuration requirements',()=>{
 const s=new Store(':memory:');let calls=0;try{
 const control=workerControl(s,{EXECUTION_MODE:'live'},()=>{calls++;});
 assert.throws(()=>control.start(),/Live mode requires/);
 s.acquire('existing',Math.floor(Date.now()/1000));assert.equal(control.start().alreadyRunning,true);assert.equal(calls,0);
 }finally{s.close();}
});
test('starting a worker requires admin authentication and does not expose secrets',async t=>{
 const s=new Store(':memory:');let calls=0;const control={start:()=>{calls++;return {started:true};},status:()=>({processRunning:false})};
 const server=createApi(new Engine(s,config({ADMIN_PASSCODE:'test-secret'})),control);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));s.close();});
 const url=`http://127.0.0.1:${server.address().port}/admin/worker/start`;
 assert.equal((await fetch(url,{method:'POST'})).status,401);assert.equal(calls,0);
 const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer test-secret'}});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{started:true});assert.equal(calls,1);
});
