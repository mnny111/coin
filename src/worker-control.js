import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export function workerControl(store,env=process.env,spawnProcess=spawn){
 let child=null,lastError=null;
 return {
  status:()=>({processRunning:!!child,error:lastError}),
  start(){
   if(child||store.get('SELECT id FROM lease WHERE expires>?',Math.floor(Date.now()/1000)))return {started:false,alreadyRunning:true};
   const c=config(env,store.setting('configuredMint'));
   if(!c.mint||!c.rpc||!c.creator)throw Object.assign(new Error('Save the Coin mint and configure SOLANA_RPC_URL and CREATOR_ADDRESS first.'),{status:400});
   lastError=null;
   child=spawnProcess(process.execPath,[fileURLToPath(new URL('./worker.js',import.meta.url))],{stdio:'inherit',env});
   child.on('error',()=>{lastError='Worker could not start. Check server logs.';});
   child.on('close',code=>{child=null;if(code)lastError='Worker stopped. Check server configuration and logs, then try again.';});
   store.audit('start-worker',{execution:c.live?'live':'observe'});
   return {started:true,execution:c.live?'live':'observe'};
  },
  stop(){if(child){const running=child;running.kill('SIGTERM');const timeout=setTimeout(()=>{if(child===running)running.kill('SIGKILL');},15000);timeout.unref();}}
 };
}
