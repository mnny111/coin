import { readFileSync } from 'node:fs';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAssociatedTokenAddressSync, createBurnCheckedInstruction, getTransferFeeConfig } from '@solana/spl-token';
import { EventParser, BN } from '@coral-xyz/anchor';
import { PUMP_SDK, OnlinePumpSdk, getPumpProgram, getPumpAmmProgram, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPdaWithQuote, feeSharingConfigPda, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput } from '@pump-fun/pump-swap-sdk';
import { verifyNestedPair, fullFeeShare } from './nested-listing.js';
import bs58 from 'bs58';

const key = value => value?.toBase58?.() ?? String(value);
const num = value => Number(value.toString());
const normalize = value => value.replaceAll('_','').toLowerCase();
const decoders = {
  createevent: 'decodeCreateEventBc', tradeevent: 'decodeTradeEventBc',
  collectcreatorfeeevent:'decodeCollectCreatorFeeEventBc',
  distributecreatorfeesevent:'decodeDistributeCreatorFeesEvent',
  createpoolevent:'decodeCreatePoolEventAmm', buyevent:'decodeBuyEventAmm', sellevent:'decodeSellEventAmm',
  collectcoincreatorfeeevent:'decodeCollectCoinCreatorFeeEventAmm',
};

export class Chain {
  constructor(c) {
    this.c=c;
    this.connection=new Connection(c.rpc,{commitment:'finalized',disableRetryOnRateLimit:true});
    this.pump=new OnlinePumpSdk(this.connection);this.amm=new OnlinePumpAmmSdk(this.connection);
    this.programs=[getPumpProgram(this.connection),getPumpAmmProgram(this.connection)];
    this.mint=new PublicKey(c.mint);this.creator=c.creator?new PublicKey(c.creator):null;
    // Observer mode never reads a signing key.
    if(c.live) {
      try {
        const data=c.privateKey?Array.from(bs58.decode(c.privateKey)):JSON.parse(readFileSync(c.keyFile,'utf8'));
        if(!Array.isArray(data)||data.length!==64||data.some(n=>!Number.isInteger(n)||n<0||n>255))throw new Error('Invalid key bytes');
        this.signer=Keypair.fromSecretKey(Uint8Array.from(data));
      } catch {
        throw new Error('Invalid signer: use a base58-encoded 64-byte Solana private key, or a readable 64-byte JSON keypair file.');
      }
      if(!this.signer.publicKey.equals(this.creator))throw new Error('Signer must be the dedicated creator wallet');
      if(c.nestedPrivateKey){
        try{const bytes=bs58.decode(c.nestedPrivateKey);if(bytes.length!==64)throw new Error();this.nestedSigner=Keypair.fromSecretKey(bytes);}
        catch{throw new Error('Invalid nested signer: use a base58-encoded 64-byte Solana private key.');}
        if(this.nestedSigner.publicKey.toBase58()!==c.nestedFeeWallet)throw new Error('Nested signer must match NESTED_FEE_WALLET');
      }
    }
  }
  decodeEvents(tx) {
    if(!tx.meta || tx.meta.err) return [];
    const message=tx.transaction.message;
    const keys=message.getAccountKeys({accountKeysFromLookups:tx.meta.loadedAddresses});
    const events=[];
    for(const program of this.programs) {
      const id=program.programId.toBase58();
      const emitted=[];
      for(const group of tx.meta.innerInstructions||[])for(let i=0;i<group.instructions.length;i++) {
        const ix=group.instructions[i];
        if(key(keys.get(ix.programIdIndex))!==id)continue;
        const bytes=Buffer.from(bs58.decode(ix.data));
        // Anchor emit_cpi self-invocation tag; CPI event bytes follow it.
        if(bytes.subarray(0,8).toString('hex')!=='e445a52e51cb9a1d')continue;
        const descriptor=program.idl.events?.find(e=>Buffer.from(e.discriminator).equals(bytes.subarray(8,16)));
        if(!descriptor)continue;
        const name=normalize(descriptor.name), decoder=decoders[name];
        if(!decoder)continue;
        emitted.push({id:`${id}:${group.index}:${i}`,name,data:PUMP_SDK[decoder](bytes.subarray(16))});
      }
      if(emitted.length)events.push(...emitted);
      else {
        // EventParser tracks the invocation stack, rejecting another program's spoofed logs.
        let i=0;
        for(const event of new EventParser(program.programId,program.coder).parseLogs(tx.meta.logMessages||[],true)) {
          const name=normalize(event.name);
          if(decoders[name])events.push({id:`${id}:log:${i}`,name,data:event.data});
          i++;
        }
      }
    }
    return events;
  }
  async ingest(tx,signature,engine) {
    if(tx.meta?.err)return;
    if(tx.blockTime==null)throw new Error('RPC omitted transaction block time');
    const events=this.decodeEvents(tx), s=engine.s;
    // RPC reads happen before committing the transaction and its cursor.
    for(const event of events) {
      const d=event.data;
      if(['buyevent','sellevent'].includes(event.name)&&!s.get('SELECT mint FROM pairs WHERE pool=?',key(d.pool))) {
        const pool=await this.amm.fetchPool(d.pool);
        if(pool.quoteMint.equals(this.mint)&&d.pool.equals(canonicalPumpPoolPdaWithQuote(pool.baseMint,this.mint)))s.run('UPDATE pairs SET pool=? WHERE mint=?',key(d.pool),key(pool.baseMint));
      }
    }
    s.transaction(()=>{
      for(const event of events) {
        const d=event.data,id=`${signature}:${event.id}`,time=tx.blockTime;
        if(event.name==='createevent') engine.addPair({mint:key(d.mint),quote:key(d.quoteMint),creator:key(d.creator),name:d.name,symbol:d.symbol,created:time,signature});
        if(event.name==='createpoolevent'&&key(d.quoteMint)===this.c.mint&&d.pool.equals(canonicalPumpPoolPdaWithQuote(d.baseMint,this.mint))) s.run('UPDATE pairs SET pool=? WHERE mint=?',key(d.pool),key(d.baseMint));
        if(event.name==='tradeevent'&&key(d.quoteMint)===this.c.mint)engine.addTrade({id,mint:key(d.mint),time,amount:d.quoteAmount.toString(),trader:key(d.user),signature});
        if(['buyevent','sellevent'].includes(event.name)) {
          const p=s.get('SELECT mint FROM pairs WHERE pool=?',key(d.pool));
          if(p)engine.addTrade({id,mint:p.mint,time,amount:(d.quoteAmountIn??d.quoteAmountOut).toString(),trader:key(d.user),signature});
        }
        if(event.name==='distributecreatorfeesevent'&&fullFeeShare(d.shareholders,this.c.nestedFeeWallet)&&key(d.sharingConfig)===key(feeSharingConfigPda(d.mint))) {
          engine.recordNestedFee({id,mint:key(d.mint),recipient:this.c.nestedFeeWallet,quote:key(d.quoteMint),amount:d.distributed.toString(),signature,time});
        }
        // Creator vaults aggregate all launches for that creator. A dedicated wallet is mandatory.
        if(event.name==='collectcreatorfeeevent'&&key(d.creator)===this.c.creator&&[key(NATIVE_MINT),key(PublicKey.default)].includes(key(d.quoteMint))) engine.addFee({id,time,amount:d.creatorFee.toString(),signature});
        if(event.name==='collectcoincreatorfeeevent'&&key(d.coinCreator)===this.c.creator) {
          const expected=getAssociatedTokenAddressSync(NATIVE_MINT,this.creator,true);
          if(key(d.coinCreatorTokenAccount)===key(expected))engine.addFee({id,time,amount:d.coinCreatorFee.toString(),signature});
        }
      }
    });
  }
  async scan(address,engine) {
    const s=engine.s, cursorKey=`cursor:${address}`, until=s.setting(cursorKey);
    let before,head=null,complete=false;
    const pending=[];
    for(let page=0;page<this.c.maxPages;page++) {
      const rows=await this.connection.getSignaturesForAddress(new PublicKey(address),{limit:1000,...(before?{before}:{}),...(until?{until}:{})},'finalized');
      if(!rows.length){complete=true;break;}
      head??=rows[0].signature;
      for(const row of rows) {
        if(row.blockTime!==null&&row.blockTime<this.c.start){complete=true;break;}
        if(!row.err)pending.push(row);
      }
      if(complete||rows.length<1000){complete=true;break;}
      before=rows.at(-1).signature;
    }
    if(!complete)throw new Error(`Scan page limit reached for ${address}; increase MAX_SCAN_PAGES. Settlement paused.`);
    for(const row of pending.reverse()) {
      const tx=await this.connection.getTransaction(row.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
      if(!tx)throw new Error(`RPC history unavailable for ${row.signature}; cursor not advanced`);
      await this.ingest(tx,row.signature,engine);
    }
    if(head)s.setting(cursorKey,head);
  }
  async index(engine) {
    const slot=await this.connection.getSlot('finalized');
    const watermark=await this.connection.getBlockTime(slot);
    if(watermark===null)throw new Error('Missing finalized block time');
    await this.scan(this.c.mint,engine);
    // Curve and pool address streams also cover legacy swaps that omit the quote mint.
    for(const pair of engine.s.all('SELECT * FROM pairs')) {
      // The parent mint stream discovers children launched against that pair.
      await this.scan(pair.mint,engine);
      await this.scan(key(bondingCurvePda(new PublicKey(pair.mint))),engine);
      const pool=canonicalPumpPoolPdaWithQuote(new PublicKey(pair.mint),this.mint);
      if(await this.connection.getAccountInfo(pool)) {
        engine.s.run('UPDATE pairs SET pool=? WHERE mint=?',key(pool),pair.mint);
        await this.scan(key(pool),engine);
      }
    }
    // Verify fee sharing afresh and index only authenticated Pump distribution events.
    for(const pair of engine.s.all('SELECT * FROM nested_pairs')) {
      try {
        await this.scan(pair.mint,engine);
        const valid=this.c.nestedFeeWallet?await verifyNestedPair(this,pair,this.c.nestedFeeWallet):false;
        engine.s.run('INSERT INTO nested_verification VALUES (?,?,?,?) ON CONFLICT(mint) DO UPDATE SET wallet=excluded.wallet,valid=excluded.valid,checked=excluded.checked',pair.mint,this.c.nestedFeeWallet||'',valid?1:0,Math.floor(Date.now()/1000));
      } catch(error) {
        engine.s.run('INSERT INTO nested_verification VALUES (?,?,0,?) ON CONFLICT(mint) DO UPDATE SET valid=0,checked=excluded.checked',pair.mint,this.c.nestedFeeWallet||'',Math.floor(Date.now()/1000));
        // A verification outage hides this listing; it cannot qualify using stale proof.
      }
    }
    if(this.creator)await this.scan(this.c.creator,engine);
    engine.s.setting('watermark',watermark);engine.s.setting('indexedAt',Math.floor(Date.now()/1000));
    return watermark;
  }
  async mainState() {
    const info=await this.connection.getAccountInfo(this.mint);
    if(!info||![key(TOKEN_PROGRAM_ID),key(TOKEN_2022_PROGRAM_ID)].includes(key(info.owner)))throw new Error('COIN_MINT is not an SPL token mint');
    const mint=await getMint(this.connection,this.mint,'finalized',info.owner);
    if(getTransferFeeConfig(mint))throw new Error('Transfer-fee main tokens are unsupported');
    const curve=await this.pump.fetchBondingCurve(this.mint);
    if(![key(PublicKey.default),key(NATIVE_MINT)].includes(key(curve.quoteMint)))throw new Error('Main Coin must be SOL-paired');
    if(this.creator&&!curve.creator.equals(this.creator))throw new Error('Main token creator differs from configured dedicated wallet; shared/CTO fee destinations require separate support');
    const poolKey=canonicalPumpPoolPdaWithQuote(this.mint,NATIVE_MINT);
    const poolInfo=await this.connection.getAccountInfo(poolKey);
    const pool=poolInfo?await this.amm.fetchPool(poolKey):null;
    if(pool&&this.creator&&!pool.coinCreator.equals(this.creator))throw new Error('Pool creator differs from configured wallet');
    return {mint,tokenProgram:info.owner,curve,pool,poolKey};
  }
  async pendingFees() {
    const state=await this.mainState();
    const vaults=await this.pump.getCreatorVaultBalanceBothPrograms(this.creator);
    return BigInt(vaults.toString())+BigInt(state.curve.creatorFee?.toString()||0)+BigInt(state.pool?.creatorFees?.toString()||0);
  }
  async pendingNestedFees(pair) {
    if(!await verifyNestedPair(this,pair,this.c.nestedFeeWallet))return 0n;
    const mint=new PublicKey(pair.mint),parent=new PublicKey(pair.parent_mint);
    const balances=await this.pump.getCreatorVaultQuoteBalances(feeSharingConfigPda(mint),[parent]);
    const curve=await this.pump.fetchBondingCurve(mint),poolKey=canonicalPumpPoolPdaWithQuote(mint,parent);
    const pool=await this.connection.getAccountInfo(poolKey)?await this.amm.fetchPool(poolKey):null;
    return BigInt(balances.find(b=>b.mint.equals(parent))?.total.toString()||0)+BigInt(curve.creatorFee?.toString()||0)+BigInt(pool?.creatorFees?.toString()||0);
  }
  async nestedInstructions(job) {
    const details=JSON.parse(job.details),user=this.nestedSigner?.publicKey;
    if(!user||details.wallet!==this.c.nestedFeeWallet||key(user)!==details.wallet)throw new Error('Nested job signer does not match its fee recipient');
    const mint=new PublicKey(details.mint),state=await this.pairState(mint);
    if(job.kind==='nested_collect'){
      const pair={mint:details.sourceMint,parent_mint:details.mint};
      if(job.recipient!==pair.mint||!await verifyNestedPair(this,pair,details.wallet))throw new Error('Nested fee share is no longer eligible');
      const built=await this.pump.buildDistributeCreatorFeesInstructions(new PublicKey(pair.mint),{quoteMint:mint,quoteTokenProgram:state.tokenProgram,payer:user});
      return {instructions:built.instructions,details:{...details,decimals:state.mint.decimals}};
    }
    if(job.kind!=='nested_burn'||job.recipient!==details.mint||!details.receiptId||BigInt(job.amount)<=0n)throw new Error('Invalid nested burn obligation');
    // Burn exactly the authenticated receipt amount, never the wallet's entire balance.
    const instruction=createBurnCheckedInstruction(getAssociatedTokenAddressSync(mint,user,true,state.tokenProgram),mint,user,BigInt(job.amount),state.mint.decimals,[],state.tokenProgram);
    return {instructions:[instruction],details:{...details,decimals:state.mint.decimals,burned:job.amount}};
  }
  async instructions(job) {
    if(['nested_collect','nested_burn'].includes(job.kind))return this.nestedInstructions(job);
    const user=this.signer.publicKey, amount=new BN(job.amount), details={};
    if(job.kind==='pair_burn')return this.pairBurnInstructions(job);
    if(!['collect','buyback','pair_funding'].includes(job.kind))throw new Error('Unsupported job kind; developer payouts are disabled');
    const state=await this.mainState();
    if(job.kind==='collect') {
      const instructions=[];
      if(state.curve.creatorFee?.gtn(0))instructions.push(await PUMP_SDK.sweepCreatorFeeInstruction({payer:user,mint:this.mint,creator:this.creator,quoteMint:NATIVE_MINT}));
      if(state.pool?.creatorFees?.gtn(0))instructions.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({payer:user,mint:this.mint,coinCreator:this.creator,quoteMint:NATIVE_MINT}));
      instructions.push(...await this.pump.collectCoinCreatorFeeV2Instructions(this.creator,NATIVE_MINT,TOKEN_PROGRAM_ID,user));
      return {instructions,details};
    }

    const built=await this.buy(this.mint,NATIVE_MINT,state,TOKEN_PROGRAM_ID,amount,user);
    if(job.kind==='buyback')this.appendBurn(built,this.mint,state,user);
    return {instructions:built.instructions,details:{mint:this.c.mint,decimals:state.mint.decimals,...(job.kind==='buyback'?{burned:built.base.toString()}:{acquired:built.base.toString(),targetMint:job.recipient})}};
  }
  async buy(mint,quoteMint,state,quoteTokenProgram,amount,user) {
    let base,instructions;
    const quoteBudget=amount.muln(10000-this.c.slippageBps).divn(10000);
    if(state.pool) {
      const swap=await this.amm.swapSolanaState(state.poolKey,user);
      const p=swap.pool;
      if(!p.baseMint.equals(mint)||!p.quoteMint.equals(quoteMint))throw new Error('Unexpected pool mints');
      const quote=buyQuoteInput({quote:quoteBudget,slippage:0,baseReserve:swap.poolBaseAmount,quoteReserve:swap.poolQuoteAmount,virtualQuoteReserves:p.virtualQuoteReserves,globalConfig:swap.globalConfig,baseMintAccount:swap.baseMintAccount,baseMint:swap.baseMint,coinCreator:p.coinCreator,creator:p.creator,feeConfig:swap.feeConfig,quoteMint:p.quoteMint,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,quoteTransferFee:swap.quoteTransferFee});
      base=quote.base;
      instructions=quoteMint.equals(NATIVE_MINT)?await PUMP_AMM_SDK.buyInstructions(swap,base,amount):await PUMP_AMM_SDK.buyV2Instructions(swap,base,amount);
    } else {
      if(state.curve.complete)throw new Error('Awaiting token migration pool');
      const global=await this.pump.fetchGlobal(),feeConfig=await this.pump.fetchFeeConfig();
      const buy=await this.pump.fetchBuyState(mint,user,state.tokenProgram,quoteMint);
      const expectedQuote=[key(PublicKey.default),key(NATIVE_MINT)].includes(key(buy.bondingCurve.quoteMint))?NATIVE_MINT:buy.bondingCurve.quoteMint;
      if(!expectedQuote.equals(quoteMint))throw new Error('Unexpected bonding curve quote');
      base=getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:new BN(state.mint.supply.toString()),bondingCurve:buy.bondingCurve,amount:quoteBudget,quoteMint,creatorFeeBps:buy.bondingCurve.creatorFeeBps});
      const args={...buy,global,mint,user,amount:base,slippage:0,tokenProgram:state.tokenProgram};
      instructions=quoteMint.equals(NATIVE_MINT)?await PUMP_SDK.buyInstructions({...args,solAmount:amount}):await PUMP_SDK.buyV2Instructions({...args,quoteAmount:amount,quoteTokenProgram});
    }
    if(base.lten(0))throw new Error('Buyback quote rounds to zero');
    return {instructions,base};
  }
  appendBurn(built,mint,state,user) {
    built.instructions.push(createBurnCheckedInstruction(getAssociatedTokenAddressSync(mint,user,true,state.tokenProgram),mint,user,BigInt(built.base.toString()),state.mint.decimals,[],state.tokenProgram));
  }
  async pairState(mint) {
    if(mint.equals(this.mint))throw new Error('Pair must differ from main Coin');
    const info=await this.connection.getAccountInfo(mint);
    if(!info||![key(TOKEN_PROGRAM_ID),key(TOKEN_2022_PROGRAM_ID)].includes(key(info.owner)))throw new Error('Invalid paired mint');
    const account=await getMint(this.connection,mint,'finalized',info.owner);
    if(getTransferFeeConfig(account))throw new Error('Transfer-fee paired tokens are unsupported');
    const curve=await this.pump.fetchBondingCurve(mint);
    if(!curve.quoteMint.equals(this.mint))throw new Error('Token is not paired with Coin');
    const poolKey=canonicalPumpPoolPdaWithQuote(mint,this.mint);
    const pool=await this.connection.getAccountInfo(poolKey)?await this.amm.fetchPool(poolKey):null;
    return {mint:account,tokenProgram:info.owner,curve,pool,poolKey};
  }
  async pairBurnInstructions(job) {
    const mint=new PublicKey(job.recipient),user=this.signer.publicKey;
    const main=await this.mainState(),state=await this.pairState(mint);
    const built=await this.buy(mint,this.mint,state,main.tokenProgram,new BN(job.amount),user);
    this.appendBurn(built,mint,state,user);
    return {instructions:built.instructions,details:{mint:job.recipient,decimals:state.mint.decimals,burned:built.base.toString(),quoteMint:this.c.mint}};
  }
  async prepare(job) {
    if(!this.c.live||!this.signer)throw new Error('Execution disabled');
    const signer=['nested_collect','nested_burn'].includes(job.kind)?this.nestedSigner:this.signer;
    if(!signer)throw new Error('Nested signer is not configured');
    const balanceNumber=await this.connection.getBalance(signer.publicKey,'finalized');
    if(!Number.isSafeInteger(balanceNumber))throw new Error('RPC wallet balance exceeds safe integer range');
    const balance=BigInt(balanceNumber);
    if(balance<(['pair_burn','nested_burn','nested_collect'].includes(job.kind)?0n:BigInt(job.amount))+BigInt(this.c.reserve))throw new Error('Insufficient wallet balance including gas reserve');
    const built=await this.instructions(job);
    const latest=await this.connection.getLatestBlockhash('finalized');
    const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:800000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:this.c.priorityMicroLamports}),...built.instructions];
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());
    tx.sign([signer]);
    const wire=tx.serialize();if(wire.length>1232)throw new Error('Transaction exceeds Solana packet size');
    const simulation=await this.connection.simulateTransaction(tx,{sigVerify:true,commitment:'finalized'});
    if(simulation.value.err)throw new Error(`Simulation rejected: ${JSON.stringify(simulation.value.err)}`);
    return {wire:Buffer.from(wire).toString('base64'),signature:bs58.encode(tx.signatures[0]),expiry:latest.lastValidBlockHeight,details:built.details};
  }
  async status(signature) {
    return (await this.connection.getSignatureStatuses([signature],{searchTransactionHistory:true})).value[0];
  }
  async send(wire) { return this.connection.sendRawTransaction(Buffer.from(wire,'base64'),{skipPreflight:false,maxRetries:0,preflightCommitment:'finalized'}); }
  async receipt(job) {
    const tx=await this.connection.getTransaction(job.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});
    if(!tx||tx.meta?.err)throw new Error('Finalized receipt unavailable');
    const details=JSON.parse(job.details);
    if(['buyback','pair_funding'].includes(job.kind)) {
      let spent=0n;
      for(const e of this.decodeEvents(tx)) {
        if(e.name==='tradeevent'&&key(e.data.user)===this.c.creator&&key(e.data.mint)===this.c.mint&&e.data.isBuy) spent+=BigInt(e.data.solAmount.toString())+BigInt(e.data.fee.toString())+BigInt(e.data.creatorFee.toString());
        if(e.name==='buyevent'&&key(e.data.user)===this.c.creator&&key(e.data.pool)===key(canonicalPumpPoolPdaWithQuote(this.mint,NATIVE_MINT))) spent+=BigInt(e.data.userQuoteAmountIn.toString());
      }
      if(spent<=0n||spent>BigInt(job.amount))throw new Error('Buyback receipt amount cannot be reconciled');
      details.spent=String(spent);details.refund=String(BigInt(job.amount)-spent);
    }
    if(job.kind==='pair_funding') {
      const acquired=this.tokenDelta(tx,this.c.mint);
      if(acquired!==BigInt(details.acquired))throw new Error('Pair funding receipt quantity differs from signed purchase');
    }
    if(job.kind==='pair_burn') {
      const spent=-this.tokenDelta(tx,this.c.mint);
      if(spent<=0n||spent>BigInt(job.amount))throw new Error('Pair quote spend cannot be reconciled');
      if(this.tokenDelta(tx,job.recipient)!==0n)throw new Error('Purchased pair tokens were not fully burned');
      details.quoteSpent=String(spent);details.quoteRefund=String(BigInt(job.amount)-spent);
    }
    if(job.kind==='nested_burn'){
      if(details.wallet!==this.c.nestedFeeWallet)throw new Error('Nested receipt wallet differs from configuration');
      if(-this.tokenDelta(tx,details.mint,details.wallet)!==BigInt(job.amount))throw new Error('Nested burn receipt amount cannot be reconciled');
      details.burned=job.amount;
    }
    if(job.kind==='nested_collect'){
      let collected=0n;
      for(const event of this.decodeEvents(tx)){
        const d=event.data;
        if(event.name==='distributecreatorfeesevent'&&key(d.mint)===details.sourceMint&&key(d.quoteMint)===details.mint&&key(d.sharingConfig)===key(feeSharingConfigPda(new PublicKey(details.sourceMint)))&&fullFeeShare(d.shareholders,details.wallet))collected+=BigInt(d.distributed.toString());
      }
      if(collected<0n||this.tokenDelta(tx,details.mint,details.wallet)!==collected)throw new Error('Nested collection receipt cannot be reconciled');
      details.collected=String(collected);
    }
    return {tx,details};
  }
  tokenDelta(tx,mint,owner=this.c.creator) {
    const sum=rows=>(rows||[]).filter(r=>r.owner===owner&&r.mint===mint).reduce((n,r)=>n+BigInt(r.uiTokenAmount.amount),0n);
    if(!tx.meta.preTokenBalances||!tx.meta.postTokenBalances)throw new Error('Missing token balances in finalized receipt');
    return sum(tx.meta.postTokenBalances)-sum(tx.meta.preTokenBalances);
  }
}
