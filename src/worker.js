import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { Engine, nowSeconds } from './engine.js';
import { Chain } from './chain.js';

export async function executeJob(s,chain,job) {
  if(job.status==='planned') {
    const prepared=await chain.prepare(job);
    // Persist signed bytes BEFORE broadcast. A lost response must never cause a new payment.
    s.run("UPDATE jobs SET status='prepared',wire=?,signature=?,expiry=?,details=?,error=NULL,updated=? WHERE id=? AND status='planned'",prepared.wire,prepared.signature,prepared.expiry,JSON.stringify(prepared.details),nowSeconds(),job.id);
    job=s.get('SELECT * FROM jobs WHERE id=?',job.id);
  }
  if(job.status!=='prepared')return;
  const status=await chain.status(job.signature);
  if(status?.confirmationStatus==='finalized') {
    if(status.err) {
      s.run("UPDATE jobs SET status='failed',error=?,updated=? WHERE id=?",JSON.stringify(status.err),nowSeconds(),job.id);
      return;
    }
    const receipt=await chain.receipt(job);
    s.transaction(()=>{
      if(s.get('SELECT status FROM jobs WHERE id=?',job.id)?.status==='confirmed')return;
      const time=nowSeconds();
      s.run("UPDATE jobs SET status='confirmed',details=?,wire=NULL,error=NULL,updated=? WHERE id=?",JSON.stringify(receipt.details),time,job.id);
      if(job.kind==='pair_funding'){
        const credit=BigInt(s.get('SELECT amount FROM pair_credits WHERE mint=?',job.recipient)?.amount||0);
        const quote=BigInt(receipt.details.acquired)+credit;
        s.run('INSERT INTO pair_credits VALUES (?,?) ON CONFLICT(mint) DO UPDATE SET amount=excluded.amount',job.recipient,'0');
        s.run('INSERT OR IGNORE INTO jobs(id,kind,amount,recipient,round,created,updated) VALUES (?,?,?,?,?,?,?)',job.id+':burn','pair_burn',String(quote),job.recipient,job.round,time,time);
      }
      if(job.kind==='pair_burn'){
        const credit=BigInt(s.get('SELECT amount FROM pair_credits WHERE mint=?',job.recipient)?.amount||0)+BigInt(receipt.details.quoteRefund||0);
        s.run('INSERT INTO pair_credits VALUES (?,?) ON CONFLICT(mint) DO UPDATE SET amount=excluded.amount',job.recipient,String(credit));
      }
    });
    return;
  }
  if(status)return; // Do not replace a processed/confirmed transaction, even if its blockhash expires.
  const height=await chain.connection.getBlockHeight('finalized');
  if(height>job.expiry) {
    // Recheck after observing finalized expiry; no new block can accept these bytes.
    if(await chain.status(job.signature))return;
    s.transaction(()=>{
      s.audit('transaction-expired',{job:job.id,signature:job.signature});
      s.run("UPDATE jobs SET status='planned',wire=NULL,signature=NULL,expiry=NULL,error=NULL,updated=? WHERE id=?",nowSeconds(),job.id);
    });
    return;
  }
  await chain.send(job.wire); // Re-broadcasts exactly the same signature on timeout/restart.
}

export async function tick(engine,chain) {
  const s=engine.s,c=engine.c;
  s.setting('workerHeartbeat',nowSeconds());
  // Reconcile pending transactions before new planning; pause never abandons in-flight work.
  if(c.live)for(const job of s.all("SELECT * FROM jobs WHERE status='prepared' ORDER BY created,id"))await executeJob(s,chain,job);
  const watermark=await chain.index(engine);
  engine.settle(watermark);engine.planBuyback();
  if(!c.live||s.setting('paused')==='true')return;
  const last=Number(s.setting('lastCollect')||0);
  if(nowSeconds()-last>=c.collectSeconds&&!s.get("SELECT id FROM jobs WHERE kind='collect' AND status!='confirmed'")) {
    const pending=await chain.pendingFees();
    if(pending>=BigInt(c.minBuyback))engine.job(`collect:${nowSeconds()}`,'collect','0');
    s.setting('lastCollect',nowSeconds());
  }
  // One prepared transaction at a time keeps wallet accounting and retries simple.
  if(s.get("SELECT id FROM jobs WHERE status='prepared'"))return;
  const job=s.get("SELECT * FROM jobs WHERE status='planned' ORDER BY CASE kind WHEN 'collect' THEN 0 WHEN 'pair_burn' THEN 1 WHEN 'buyback' THEN 2 ELSE 3 END,created,id LIMIT 1");
  if(job) {
    try { await executeJob(s,chain,job); }
    catch(error) {
      // A bad/illiquid pair must not block all other jobs; preserve its allocation for explicit retry.
      s.run("UPDATE jobs SET status=CASE WHEN status='planned' THEN 'failed' ELSE status END,error=?,updated=? WHERE id=?",String(error.message).slice(0,500),nowSeconds(),job.id);
      throw error;
    }
  }
}

async function main() {
  const c=config();
  if(!c.rpc||!c.mint||!c.creator||!c.start)throw new Error('Worker requires SOLANA_RPC_URL, COIN_MINT, CREATOR_ADDRESS, START_TIME');
  const s=new Store(c.db),engine=new Engine(s,c),chain=new Chain(c),owner=randomUUID();
  if(!s.acquire(owner,nowSeconds()))throw new Error('Another worker owns this database');
  let stopped=false;
  // Fail-stop on a lost lease, including while a long RPC scan is in flight.
  const heartbeat=setInterval(()=>{try{if(!s.acquire(owner,nowSeconds()))process.exit(1);}catch{process.exit(1);}},30000);
  heartbeat.unref();
  process.on('SIGINT',()=>{stopped=true;});process.on('SIGTERM',()=>{stopped=true;});
  console.log(`Coin worker: ${c.live?'live':'observe'} mode`);
  try {
    const initialState=await chain.mainState();s.setting('coinDecimals',initialState.mint.decimals);
    while(!stopped) {
      try { await tick(engine,chain);s.setting('workerError',''); }
      catch(error) {s.setting('workerError',String(error.message).slice(0,500));console.error('Worker cycle failed; see local operator status.');}
      if(!stopped)await new Promise(resolve=>setTimeout(resolve,c.interval*1000));
    }
  } finally {clearInterval(heartbeat);s.run('DELETE FROM lease WHERE owner=?',owner);s.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
