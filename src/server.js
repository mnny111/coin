import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
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
export function createApi(engine) {
  const s=engine.s,c=engine.c;
  return createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    const send=(status,data)=>{res.writeHead(status);res.end(json(data));};
    try {
      const url=new URL(req.url,'http://localhost'),path=url.pathname;
      const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||50));
      const offset=Math.max(0,Number(url.searchParams.get('offset'))||0);
      if(!Number.isInteger(limit)||!Number.isSafeInteger(offset))return send(400,{error:'Invalid pagination'});
      if(req.method==='GET'&&path==='/health')return send(200,{ok:true,name:'Coin',configured:!!(c.mint&&c.creator&&c.rpc&&c.start),execution:c.live?'live':'observe',indexedAt:Number(s.setting('indexedAt'))||null,workerHealthy:nowSeconds()-Number(s.setting('workerHeartbeat')||0)<Math.max(120,c.interval*3)&&!s.setting('workerError')});
      if(req.method==='GET'&&path==='/api/config')return send(200,{name:c.name,mint:c.mint,creator:c.creator,execution:c.live?'live':'observe',roundSeconds:c.roundSeconds,buybackBps:c.buybackBps,rewardsBps:c.rewardsBps,treasuryBps:10000-c.buybackBps-c.rewardsBps,winnerWeights:c.winnerWeights,ranking:'quote-token trading volume; coins launched within the round',launchUrl:'https://pump.fun/create',requiresWalletConnection:false});
      if(req.method==='GET'&&path==='/api/stats')return send(200,{...engine.totals(),pairs:s.get('SELECT COUNT(*) AS n FROM pairs').n,watermark:Number(s.setting('watermark'))||null});
      if(req.method==='GET'&&path==='/api/pairs')return send(200,{items:s.all('SELECT * FROM pairs ORDER BY created DESC,mint LIMIT ? OFFSET ?',limit,offset),limit,offset});
      if(req.method==='GET'&&path==='/api/rounds/current') {
        const start=Math.floor(nowSeconds()/c.roundSeconds)*c.roundSeconds;
        return send(200,{start,end:start+c.roundSeconds,pot:engine.totals().availableRewards,leaderboard:engine.leaderboard(start),indexedThrough:Number(s.setting('watermark'))||null});
      }
      if(req.method==='GET'&&path==='/api/rounds')return send(200,{items:s.all('SELECT * FROM rounds ORDER BY start DESC LIMIT ? OFFSET ?',limit,offset).map(r=>({...r,winners:JSON.parse(r.winners)}))});
      if(req.method==='GET'&&path==='/api/transactions')return send(200,{items:engine.publicJobs(limit,offset)});
      if(req.method==='GET'&&path==='/api/fees')return send(200,{items:s.all('SELECT * FROM fees ORDER BY time DESC,id LIMIT ? OFFSET ?',limit,offset).map(f=>({...f,explorer:`https://solscan.io/tx/${f.signature}`}))});
      if(path.startsWith('/admin/')) {
        if(!authorized(req,c.adminToken))return send(401,{error:'Unauthorized'});
        if(req.method==='GET'&&path==='/admin/status')return send(200,{paused:s.setting('paused')==='true',workerError:s.setting('workerError'),heartbeat:s.setting('workerHeartbeat'),jobs:s.all('SELECT id,status,error FROM jobs WHERE status!=\'confirmed\' LIMIT 100')});
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
  const c=config(),s=new Store(c.db),engine=new Engine(s,c),server=createApi(engine);
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.listen(c.port,c.host,()=>console.log(`Coin API listening on http://${c.host}:${c.port}`));
  const shutdown=()=>server.close(()=>{s.close();process.exit(0);});process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
