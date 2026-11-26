import { createHash } from 'node:crypto';

export const nowSeconds = () => Math.floor(Date.now()/1000);
export function units(value) {
  const s = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(s)) throw new Error('Invalid unsigned integer');
  return BigInt(s);
}
export function splitFees(amount, buybackBps = 7000, rewardsBps = 3000) {
  const a = units(amount);
  if (![buybackBps,rewardsBps].every(n => Number.isInteger(n) && n >= 0) || buybackBps + rewardsBps > 10000) throw new Error('Invalid allocation');
  const buyback = a * BigInt(buybackBps) / 10000n;
  const rewards = buybackBps + rewardsBps === 10000 ? a - buyback : a * BigInt(rewardsBps) / 10000n;
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
    store.transaction(()=>{
    const savedStart=store.setting('indexStart');
    if(savedStart)config.start=Number(savedStart);
    else if(config.mint&&config.creator){
      if(store.setting('policy')&&!config.start)throw new Error('Existing ledger needs its original START_TIME once to preserve accounting; it will then be saved automatically.');
      config.start=config.start||nowSeconds();
    }
    const policy = JSON.stringify({mint:config.mint,creator:config.creator,start:config.start,round:config.roundSeconds,buy:config.buybackBps,rewards:config.rewardsBps,pairPolicy:'all-volume-v1'});
    const hash=createHash('sha256').update(policy).digest('hex');
    const previous=store.setting('policy');
    if (previous && previous!==hash) throw new Error('Accounting policy changed. Use a new database or an explicit reviewed migration.');
    if(config.mint&&config.creator&&config.start){store.setting('policy',hash);store.setting('indexStart',config.start);}
    });
  }
  addPair(p) {
    if(p.mint===this.c.mint||p.mint===p.quote)return false;
    if(p.quote!==this.c.mint){
      // Nested launches stay private until their fee contribution can be verified.
      if(!this.s.get('SELECT mint FROM pairs WHERE mint=?',p.quote))return false;
      return !!this.s.run('INSERT OR IGNORE INTO nested_pairs(mint,parent_mint,creator,name,symbol,created,signature) VALUES (?,?,?,?,?,?,?)',p.mint,p.quote,p.creator,p.name,p.symbol,p.created,p.signature).changes;
    }
    return !!this.s.run('INSERT OR IGNORE INTO pairs(mint,creator,name,symbol,created,signature) VALUES (?,?,?,?,?,?)',p.mint,p.creator,p.name,p.symbol,p.created,p.signature).changes;
  }
  recordNestedFee(f) {
    const pair=this.s.get('SELECT * FROM nested_pairs WHERE mint=?',f.mint);
    if(!this.c.nestedFeeWallet||!pair||f.recipient!==this.c.nestedFeeWallet||f.quote!==pair.parent_mint||units(f.amount)===0n)return false;
    return !!this.s.run('INSERT OR IGNORE INTO nested_fee_receipts VALUES (?,?,?,?,?,?,?)',f.id,f.mint,f.recipient,f.quote,String(f.amount),f.signature,f.time).changes;
  }
  planNestedBurns(watermark) {
    if(!this.c.nestedFeeWallet)return;
    this.s.transaction(()=>{
      for(const f of this.s.all('SELECT * FROM nested_fee_receipts WHERE recipient=? AND time<=?',this.c.nestedFeeWallet,watermark)){
        const id='nested-burn:'+createHash('sha256').update(f.id).digest('hex');
        const details={receiptId:f.id,sourceMint:f.mint,mint:f.quote_mint,wallet:f.recipient};
        this.s.run('INSERT OR IGNORE INTO jobs(id,kind,amount,recipient,details,created,updated) VALUES (?,?,?,?,?,?,?)',id,'nested_burn',f.amount,f.quote_mint,JSON.stringify(details),nowSeconds(),nowSeconds());
      }
    });
  }
  listedPairs(now=nowSeconds()) {
    const direct=this.s.all('SELECT * FROM pairs').map(p=>({...p,depth:1,parent_mint:this.c.mint,parent_symbol:'COIN'}));
    if(!this.c.nestedFeeWallet)return direct;
    const nested=this.s.all(`SELECT n.*,p.symbol AS parent_symbol,2 AS depth FROM nested_pairs n JOIN pairs p ON p.mint=n.parent_mint JOIN nested_verification v ON v.mint=n.mint
      WHERE v.wallet=? AND v.valid=1 AND v.checked>=? AND EXISTS(SELECT 1 FROM nested_fee_receipts r WHERE r.mint=n.mint AND r.recipient=? AND r.quote_mint=n.parent_mint)`,this.c.nestedFeeWallet,now-300,this.c.nestedFeeWallet);
    return [...direct,...nested];
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
    const result={collected:0n,buyback:0n,rewards:0n,treasury:0n,burned:0n,pairFunded:0n,pairBurns:0};
    for(const row of this.s.all('SELECT * FROM fees')) {result.collected+=BigInt(row.amount);for(const k of ['buyback','rewards','treasury'])result[k]+=BigInt(row[k]);}
    let reservedBuy=0n,reservedRewards=0n;
    for(const job of this.s.all('SELECT * FROM jobs WHERE kind IN (\'buyback\',\'pair_funding\')')) {
      // Failed jobs retain their reservation until an operator retries them.
      if(job.kind==='buyback') {
        reservedBuy+=BigInt(job.amount);
        if(job.status==='confirmed') {const d=JSON.parse(job.details);result.burned+=BigInt(d.burned||0);reservedBuy-=BigInt(d.refund||0);}
      } else {reservedRewards+=BigInt(job.amount);if(job.status==='confirmed'){const d=JSON.parse(job.details);reservedRewards-=BigInt(d.refund||0);result.pairFunded+=BigInt(d.spent||0);}}
    }
    result.pairBurns=this.s.get("SELECT COUNT(*) AS n FROM jobs WHERE kind='pair_burn' AND status='confirmed'").n;
    const nestedBurns={};
    for(const job of this.s.all("SELECT recipient,amount FROM jobs WHERE kind='nested_burn' AND status='confirmed'"))nestedBurns[job.recipient]=String(BigInt(nestedBurns[job.recipient]||0)+BigInt(job.amount));
    const pairQuoteCredits=this.s.all('SELECT * FROM pair_credits');
    return {...result,nestedBurns,pairQuoteCredits,availableBuyback:result.buyback-reservedBuy,availableRewards:result.rewards-reservedRewards};
  }
  leaderboard(start) {
    const end=start+this.c.roundSeconds;
    const pairs=this.s.all('SELECT * FROM pairs WHERE created<?',end);
    const totals=new Map(pairs.map(p=>[p.mint,0n]));
    for(const t of this.s.all('SELECT mint,amount FROM trades WHERE time>=? AND time<? AND trader!=?',start,end,this.c.creator))if(totals.has(t.mint))totals.set(t.mint,totals.get(t.mint)+BigInt(t.amount));
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
          const winners=this.leaderboard(start);
          // Only fee receipts finalized before this round's end may fund it.
          const earned=this.s.all('SELECT rewards FROM fees WHERE time<?',end).reduce((a,f)=>a+BigInt(f.rewards),0n);
          const reserved=this.s.all("SELECT * FROM jobs WHERE kind='pair_funding'").reduce((a,j)=>a+BigInt(j.amount)-(j.status==='confirmed'&&j.updated<end?BigInt(JSON.parse(j.details).refund||0):0n),0n);
          const pot=earned-reserved;
          if(pot<0n) throw new Error('Pair buyback accounting underflow');
          const amounts=proportional(pot,winners.map(p=>p.volume));
          const snapshot=winners.map((p,i)=>({mint:p.mint,creator:p.creator,volume:String(p.volume),amount:String(amounts[i])}));
          this.s.run('INSERT INTO rounds VALUES (?,?,?,?,?)',start,end,String(winners.length?pot:0n),JSON.stringify(snapshot),nowSeconds());
          snapshot.forEach((w,i)=>{
            const cap=BigInt(this.c.maxBuyback);if(cap<=0n)throw new Error('Buyback cap must be positive');
            let remaining=BigInt(w.amount),part=0;
            while(remaining>0n){const chunk=remaining<cap?remaining:cap;this.job(`pair:${start}:${i+1}${part?':'+part:''}`,'pair_funding',chunk,w.mint,start);remaining-=chunk;part++;}
          });
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
