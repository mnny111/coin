import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Both processes share one persistent database; a worker failure must not stop the website.
const children=new Set();
let shuttingDown=false,retry;
function launch(file){
 const child=spawn(process.execPath,[fileURLToPath(new URL(file,import.meta.url))],{stdio:'inherit',env:process.env});
 children.add(child);
 child.on('error',()=>console.error(`${file} could not start.`));
 child.on('close',code=>{
  children.delete(child);
  if(shuttingDown)return;
  if(file==='server.js'){stop(code||1);return;}
  console.error('Worker stopped; website remains available. Retrying configuration in 15 seconds.');
  retry=setTimeout(()=>launch('worker.js'),15000);
 });
 return child;
}
function stop(code=0){
 if(shuttingDown)return;shuttingDown=true;clearTimeout(retry);process.exitCode=code;
 for(const child of children)child.kill('SIGTERM');
 setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code);},15000).unref();
}
// Worker starts only through the authenticated admin control.
launch('server.js');
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
