import { createHash } from 'node:crypto';

export const nowSeconds = () => Math.floor(Date.now()/1000);
export function units(value) {
  const s = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error('Invalid unsigned integer');
  return BigInt(s);
}
export function splitFees(amount, buybackBps = 6000, rewardsBps = 2000) {
  const a = units(amount);
  if (![buybackBps,rewardsBps].every(n => Number.isInteger(n) && n >= 0) || buybackBps + rewardsBps > 10000) throw new Error('Invalid allocation');
  const buyback = a * BigInt(buybackBps) / 10000n;
  const rewards = a * BigInt(rewardsBps) / 10000n;
  return { buyback, rewards, treasury: a-buyback-rewards };
}
export function proportional(amount, weights) {
  const a = units(amount), total = weights.reduce((s,n) => s+BigInt(n), 0n);
  if (!weights.length || total <= 0n) return [];
  const shares = weights.map(w => a*BigInt(w)/total);
  let dust = a - shares.reduce((s,n) => s+n,0n);
  for (let i=0; dust>0n; i++,dust--) shares[i%shares.length]++;
  return shares;
}
export class Engine {
  constructor(store, config) {
    this.s=store; this.c=config;
    const policy = JSON.stringify({mint:config.mint,creator:config.creator,start:config.start,round:config.roundSeconds,buy:config.buybackBps,rewards:config.rewardsBps,weights:config.winnerWeights});
    const hash=createHash('sha256').update(policy).digest('hex');
    const previous=store.setting('policy');
    if (previous && previous!==hash) throw new Error('Accounting policy changed. Use a new database or an explicit reviewed migration.');
    if(config.mint&&config.creator&&config.start)store.setting('policy',hash);
  }
  addPair(p) {
    if (p.quote !== this.c.mint || p.mint === this.c.mint) return false;
    return !!this.s.run('INSERT OR IGNORE INTO pairs(mint,creator,name,symbol,created,signature) VALUES (?,?,?,?,?,?)',p.mint,p.creator,p.name,p.symbol,p.created,p.signature).changes;
  }
  addTrade(t) {
    if (!this.s.get('SELECT mint FROM pairs WHERE mint=?',t.mint)) return false;
    const amount=units(t.amount); if (!amount) return false;
    return !!this.s.run('INSERT OR IGNORE INTO trades VALUES (?,?,?,?,?,?)',t.id,t.mint,t.time,String(amount),t.trader,t.signature).changes;
  }
  addFee(f) {
    const a=units(f.amount); if (!a || f.time < this.c.start) return false;
    const split=splitFees(a,this.c.buybackBps,this.c.rewardsBps);
    return !!this.s.run('INSERT OR IGNORE INTO fees VALUES (?,?,?,?,?,?,?)',f.id,f.time,String(a),String(split.buyback),String(split.rewards),String(split.treasury),f.signature).changes;
  }
  totals() {
    const result={collected:0n,buyback:0n,rewards:0n,treasury:0n,burned:0n,paid:0n};
    for(const row of this.s.all('SELECT * FROM fees')) {result.collected+=BigInt(row.amount);for(const k of ['buyback','rewards','treasury'])result[k]+=BigInt(row[k]);}
    let reservedBuy=0n,reservedRewards=0n;
    for(const job of this.s.all('SELECT * FROM jobs WHERE kind IN (\'buyback\',\'reward\')')) {
      // Failed jobs retain their reservation until an operator retries them.
      if(job.kind==='buyback') {
        reservedBuy+=BigInt(job.amount);
        if(job.status==='confirmed') {const d=JSON.parse(job.details);result.burned+=BigInt(d.burned||0);reservedBuy-=BigInt(d.refund||0);}
      } else {reservedRewards+=BigInt(job.amount);if(job.status==='confirmed')result.paid+=BigInt(job.amount);}
    }
    return {...result,availableBuyback:result.buyback-reservedBuy,availableRewards:result.rewards-reservedRewards};
  }
  leaderboard(start) {
    const end=start+this.c.roundSeconds;
    const pairs=this.s.all('SELECT * FROM pairs WHERE created>=? AND created<?',start,end);
    const totals=new Map(pairs.map(p=>[p.mint,0n]));
    for(const t of this.s.all('SELECT mint,amount FROM trades WHERE time>=? AND time<?',start,end))if(totals.has(t.mint))totals.set(t.mint,totals.get(t.mint)+BigInt(t.amount));
    return pairs.map(p=>({...p,volume:totals.get(p.mint)})).filter(p=>p.volume>0n).sort((a,b)=>a.volume!==b.volume?(a.volume>b.volume?-1:1):a.created-b.created||a.mint.localeCompare(b.mint));
  }
  job(id,kind,amount,recipient=null,round=null,created=nowSeconds()) {
    this.s.run('INSERT OR IGNORE INTO jobs(id,kind,amount,recipient,round,created,updated) VALUES (?,?,?,?,?,?,?)',id,kind,String(amount),recipient,round,created,created);
  }
  settle(watermark) {
    if (!this.c.start) return;
    // Called only after both chain scans complete; never close a partially indexed round.
    this.s.transaction(()=>{
      let start=Number(this.s.setting('nextRound') ?? Math.floor(this.c.start/this.c.roundSeconds)*this.c.roundSeconds);
      while(start+this.c.roundSeconds+this.c.settlementDelay<=watermark) {
        const end=start+this.c.roundSeconds;
        if(!this.s.get('SELECT start FROM rounds WHERE start=?',start)) {
          const winners=this.leaderboard(start).slice(0,3);
          // Only fee receipts finalized before this round's end may fund it.
          const earned=this.s.all('SELECT rewards FROM fees WHERE time<?',end).reduce((a,f)=>a+BigInt(f.rewards),0n);
          const reserved=this.s.all("SELECT amount FROM jobs WHERE kind='reward'").reduce((a,j)=>a+BigInt(j.amount),0n);
          const pot=earned-reserved;
          if(pot<0n) throw new Error('Reward accounting underflow');
          const amounts=proportional(pot,this.c.winnerWeights.slice(0,winners.length));
          const snapshot=winners.map((p,i)=>({mint:p.mint,creator:p.creator,volume:String(p.volume),amount:String(amounts[i])}));
          this.s.run('INSERT INTO rounds VALUES (?,?,?,?,?)',start,end,String(winners.length?pot:0n),JSON.stringify(snapshot),nowSeconds());
          snapshot.forEach((w,i)=>{if(BigInt(w.amount)>0n)this.job(`reward:${start}:${i+1}`,'reward',w.amount,w.creator,start);});
        }
        start=end;
      }
      this.s.setting('nextRound',start);
    });
  }
  planBuyback() {
    this.s.transaction(()=>{
      if(this.s.get("SELECT id FROM jobs WHERE kind='buyback' AND status!='confirmed'"))return;
      const available=this.totals().availableBuyback;
      if(available<BigInt(this.c.minBuyback))return;
      const cap=BigInt(this.c.maxBuyback), amount=available<cap?available:cap;
      const n=Number(this.s.setting('buybackSequence')||0)+1;
      this.job(`buyback:${n}`,'buyback',amount);this.s.setting('buybackSequence',n);
    });
  }
  publicJobs(limit=100,offset=0) {
    return this.s.all('SELECT id,kind,amount,recipient,round,status,signature,details,created,updated FROM jobs ORDER BY created DESC,id DESC LIMIT ? OFFSET ?',limit,offset).map(j=>({...j,details:JSON.parse(j.details),explorer:j.signature?`https://solscan.io/tx/${j.signature}`:null}));
  }
}
