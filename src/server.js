import { PublicKey } from '@solana/web3.js';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { workerControl } from './worker-control.js';
import { config } from './config.js';
import { Store } from './store.js';
import { Engine,nowSeconds } from './engine.js';

const json=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
function authorized(req,token) {
  if(!token)return false;
  const actual=Buffer.from(req.headers.authorization||''),expected=Buffer.from(`Bearer ${token}`);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
async function body(req) {
  let text='';
  for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>4096)throw Object.assign(new Error('Body too large'),{status:413});}
  try{return JSON.parse(text||'{}');}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
}
export function createApi(engine, control=null) {
  const s=engine.s,c=engine.c;
  const attempts=new Map();
  return createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    const send=(status,data)=>{res.writeHead(status);res.end(json(data));};
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const pages=['/admin','/','/buybacks','/rewards','/activity','/about'];
      const assets={'/admin.js':['admin.js','text/javascript'],'/admin.css':['admin.css','text/css'],'/app.js':['app.js','text/javascript'],'/styles.css':['styles.css','text/css'],'/favicon.svg':['favicon.svg','image/svg+xml'],'/coin-logo.png':['coin-logo.png','image/png'],'/poppins-bold.ttf':['poppins-bold.ttf','font/ttf']};
      if(req.method==='GET'&&(pages.includes(path)||assets[path])) {
        const [file,type]=assets[path]||[path==='/admin'?'admin.html':'index.html','text/html'];
        const content=await readFile(new URL(`../public/${file}`,import.meta.url));
        res.setHeader('Content-Type',`${type}; charset=utf-8`);
        res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        res.writeHead(200);res.end(content);return;
      }
      const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50));
      const offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
      if(!Number.isInteger(limit)||!Number.isSafeInteger(offset))return send(400,{error:'Invalid pagination'});
      if(req.method==='GET'&&path==='/health')return send(200,{ok:true,name:'Coin',configured:!!(c.mint&&c.creator&&c.rpc&&c.start),execution:c.live?'live':'observe',indexedAt:Number(s.setting('indexedAt'))||null,workerHealthy:nowSeconds()-Number(s.setting('workerHeartbeat')||0)<Math.max(120,c.interval*3)&&!s.setting('workerError')});
      if(req.method==='GET'&&path==='/api/config')return send(200,{name:c.name,mint:c.mint,decimals:s.setting('coinDecimals')===null?null:Number(s.setting('coinDecimals')),creator:c.creator,execution:c.live?'live':'observe',roundSeconds:c.roundSeconds,buybackBps:c.buybackBps,rewardsBps:c.rewardsBps,treasuryBps:10000-c.buybackBps-c.rewardsBps,pairBuybackBps:c.rewardsBps,pairPolicy:'all-volume-v1',ranking:'all paired coins with round volume; operator trades excluded',launchUrl:'https://pump.fun/create',requiresWalletConnection:false,nestedListing:{wallet:c.nestedFeeWallet,requiredShareBps:10000,requiresConfirmedDistribution:true,burnPolicy:'100% parent tokens',burnExecution:c.live&&!!c.nestedPrivateKey?'live':'disabled'}});
      if(req.method==='GET'&&path==='/api/stats')return send(200,{...engine.totals(),pairs:engine.listedPairs().length,watermark:Number(s.setting('watermark'))||null});
      if(req.method==='GET'&&path==='/api/pairs') {
        const q=(url.searchParams.get('q')||'').slice(0,100).toLowerCase();
        const items=engine.listedPairs().filter(p=>[p.name,p.symbol,p.mint].some(v=>v.toLowerCase().includes(q))).sort((a,b)=>b.created-a.created||a.mint.localeCompare(b.mint));
        return send(200,{items:items.slice(offset,offset+limit),total:items.length,limit,offset});
      }
      if(req.method==='GET'&&path==='/api/rounds/current') {
        const start=Math.floor(nowSeconds()/c.roundSeconds)*c.roundSeconds;
        return send(200,{start,end:start+c.roundSeconds,pot:engine.totals().availableRewards,leaderboard:engine.leaderboard(start),indexedThrough:Number(s.setting('watermark'))||null});
      }
      if(req.method==='GET'&&path==='/api/rounds')return send(200,{items:s.all('SELECT * FROM rounds ORDER BY start DESC LIMIT ? OFFSET ?',limit,offset).map(r=>({...r,winners:JSON.parse(r.winners)}))});
      if(req.method==='GET'&&path==='/api/transactions')return send(200,{items:engine.publicJobs(limit,offset)});
      if(req.method==='GET'&&path==='/api/fees')return send(200,{items:s.all('SELECT * FROM fees ORDER BY time DESC,id LIMIT ? OFFSET ?',limit,offset).map(f=>({...f,explorer:`https://solscan.io/tx/${f.signature}`}))});
      if(path.startsWith('/admin/')) {
        const ip=req.socket.remoteAddress||'unknown',now=Date.now();
        let attempt=attempts.get(ip);
        if(attempt&&now-attempt.since>=60000){attempts.delete(ip);attempt=null;}
        if(attempt?.count>=10){res.setHeader('Retry-After',String(Math.ceil((60000-(now-attempt.since))/1000)));return send(429,{error:'Too many incorrect passcodes. Try again in a minute.'});}
        if(!authorized(req,c.adminPasscode)){
          if(!attempt){if(attempts.size>=1000)attempts.delete(attempts.keys().next().value);attempt={count:0,since:now};attempts.set(ip,attempt);}
          attempt.count++;return send(401,{error:'Unauthorized'});
        }
        attempts.delete(ip);
        if(req.method==='GET'&&path==='/admin/config')return send(200,{mint:c.mint,locked:!!s.setting('policy')||!!s.get('SELECT id FROM lease WHERE expires>?',nowSeconds()),rpcConfigured:!!c.rpc,creatorConfigured:!!c.creator,startConfigured:!!c.start,execution:c.live?'live':'observe',nestedFeeWallet:c.nestedFeeWallet});
        if(req.method==='POST'&&path==='/admin/config'){
          const input=await body(req);
          if(Object.keys(input).some(k=>k!=='mint')||typeof input.mint!=='string'||!input.mint.trim())return send(400,{error:'Enter a Coin mint address.'});
          let mint;try{mint=new PublicKey(input.mint.trim()).toBase58();}catch{return send(400,{error:'Enter a valid Solana mint address.'});}
          const result=s.transaction(()=>{
            if(mint===c.mint)return {unchanged:true};
            if(s.setting('policy')||s.get('SELECT id FROM lease WHERE expires>?',nowSeconds())||['pairs','nested_pairs','fees','trades','rounds','jobs'].some(table=>s.get(`SELECT 1 AS found FROM ${table} LIMIT 1`)))return {locked:true};
            s.setting('configuredMint',mint);s.audit('configure-mint',{previous:c.mint,mint});return {saved:true};
          });
          if(result.locked)return send(409,{error:'This ledger is already in use. Changing its mint requires a separate database or a reviewed migration.'});
          c.mint=mint;
          return send(200,{mint,saved:!!result.saved,message:'Coin mint saved. Use Start worker when you are ready.'});
        }
        if(req.method==='POST'&&path==='/admin/worker/start'){
          if(!control)return send(503,{error:'Worker controls are unavailable in this server.'});
          try{return send(200,control.start());}catch(error){return send(400,{error:error.message});}
        }
        if(req.method==='GET'&&path==='/admin/status')return send(200,{workerControl:control?.status()||null,paused:s.setting('paused')==='true',workerError:s.setting('workerError'),heartbeat:s.setting('workerHeartbeat'),jobs:s.all('SELECT id,status,error FROM jobs WHERE status!=\'confirmed\' LIMIT 100')});
        if(req.method==='POST'&&path==='/admin/pause') {
          const b=await body(req);if(typeof b.paused!=='boolean')return send(400,{error:'paused must be boolean'});
          s.transaction(()=>{s.setting('paused',b.paused);s.audit('pause',{paused:b.paused});});return send(200,{paused:b.paused});
        }
        if(req.method==='POST'&&path==='/admin/retry') {
          const b=await body(req);if(typeof b.id!=='string')return send(400,{error:'id required'});
          const changed=s.transaction(()=>{
            const job=s.get("SELECT * FROM jobs WHERE id=? AND status='failed'",b.id);if(!job)return false;
            s.audit('retry',{id:b.id,previousSignature:job.signature});
            s.run("UPDATE jobs SET status='planned',signature=NULL,wire=NULL,expiry=NULL,error=NULL,updated=? WHERE id=?",nowSeconds(),b.id);return true;
          });
          return send(changed?200:409,{retried:changed});
        }
      }
      send(404,{error:'Not found',endpoints:['/health','/api/config','/api/stats','/api/pairs','/api/rounds/current','/api/rounds','/api/transactions','/api/fees']});
    } catch(error) {send(error.status||500,{error:error.status?error.message:'Internal server error'});}
  });
}
function main() {
  const s=new Store(resolve(process.env.DATABASE_PATH||'data/coin.sqlite')),c=config(process.env,s.setting('configuredMint'),{requireLiveConfig:false}),engine=new Engine(s,c),control=workerControl(s),server=createApi(engine,control);
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(c.port,c.host,()=>console.log(`Coin API listening on http://${c.host}:${c.port}`));
  const shutdown=()=>{control.stop();server.close(()=>{s.close();process.exit(0);});};process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
