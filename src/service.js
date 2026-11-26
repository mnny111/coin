import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// API and worker share one local volume. Run one service replica, not two isolated disks.
const children=['server.js','worker.js'].map(file=>spawn(process.execPath,[fileURLToPath(new URL(file,import.meta.url))],{stdio:'inherit',env:process.env}));
let shuttingDown=false;
function stop(code=0) {
  if(shuttingDown)return;shuttingDown=true;process.exitCode=code;
  for(const child of children)child.kill('SIGTERM');
  setTimeout(()=>{for(const child of children)child.kill('SIGKILL');process.exit(code);},15000).unref();
}
for(const child of children){child.on('error',()=>stop(1));child.on('exit',code=>{if(!shuttingDown)stop(code||1);});}
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
