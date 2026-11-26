import { readFileSync } from 'node:fs';
import { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getMint, getAssociatedTokenAddressSync, createBurnCheckedInstruction, getTransferFeeConfig } from '@solana/spl-token';
import { EventParser, BN } from '@coral-xyz/anchor';
import { PUMP_SDK, OnlinePumpSdk, getPumpProgram, getPumpAmmProgram, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, bondingCurvePda, canonicalPumpPoolPdaWithQuote, getBuyTokenAmountFromSolAmount } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput } from '@pump-fun/pump-swap-sdk';
import bs58 from 'bs58';

const key = value => value?.toBase58?.() ?? String(value);
const num = value => Number(value.toString());
const normalize = value => value.replaceAll('_','').toLowerCase();
const decoders = {
  createevent: 'decodeCreateEventBc', tradeevent: 'decodeTradeEventBc',
  collectcreatorfeeevent:'decodeCollectCreatorFeeEventBc',
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
      const data=JSON.parse(readFileSync(c.keyFile,'utf8'));
      if(!Array.isArray(data)||data.length!==64||data.some(n=>!Number.isInteger(n)||n<0||n>255))throw new Error('Signer must be a 64-byte Solana JSON keypair');
      this.signer=Keypair.fromSecretKey(Uint8Array.from(data));
      if(!this.signer.publicKey.equals(this.creator))throw new Error('Signer must be the dedicated creator wallet');
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
      await this.scan(key(bondingCurvePda(new PublicKey(pair.mint))),engine);
      const pool=canonicalPumpPoolPdaWithQuote(new PublicKey(pair.mint),this.mint);
      if(await this.connection.getAccountInfo(pool)) {
        engine.s.run('UPDATE pairs SET pool=? WHERE mint=?',key(pool),pair.mint);
        await this.scan(key(pool),engine);
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
  async instructions(job) {
    const user=this.signer.publicKey, amount=new BN(job.amount), details={};
    if(job.kind==='reward')return {instructions:[SystemProgram.transfer({fromPubkey:user,toPubkey:new PublicKey(job.recipient),lamports:BigInt(job.amount)})],details};
    const state=await this.mainState();
    if(job.kind==='collect') {
      const instructions=[];
      if(state.curve.creatorFee?.gtn(0))instructions.push(await PUMP_SDK.sweepCreatorFeeInstruction({payer:user,mint:this.mint,creator:this.creator,quoteMint:NATIVE_MINT}));
      if(state.pool?.creatorFees?.gtn(0))instructions.push(await PUMP_SDK.sweepPoolCreatorFeeInstruction({payer:user,mint:this.mint,coinCreator:this.creator,quoteMint:NATIVE_MINT}));
      instructions.push(...await this.pump.collectCoinCreatorFeeV2Instructions(this.creator,NATIVE_MINT,TOKEN_PROGRAM_ID,user));
      return {instructions,details};
    }
    if(job.kind!=='buyback')throw new Error('Unknown job kind');
    let base,instructions;
    const quoteBudget=amount.muln(10000-this.c.slippageBps).divn(10000);
    if(state.pool) {
      const swap=await this.amm.swapSolanaState(state.poolKey,user);
      const p=swap.pool;
      const quote=buyQuoteInput({quote:quoteBudget,slippage:0,baseReserve:swap.poolBaseAmount,quoteReserve:swap.poolQuoteAmount,virtualQuoteReserves:p.virtualQuoteReserves,globalConfig:swap.globalConfig,baseMintAccount:swap.baseMintAccount,baseMint:swap.baseMint,coinCreator:p.coinCreator,creator:p.creator,feeConfig:swap.feeConfig,quoteMint:p.quoteMint,isMayhemMode:p.isMayhemMode,creatorFeeBps:p.creatorFeeBps,quoteTransferFee:swap.quoteTransferFee});
      base=quote.base;
      instructions=await PUMP_AMM_SDK.buyInstructions(swap,base,amount);
    } else {
      if(state.curve.complete)throw new Error('Awaiting main coin migration pool');
      const global=await this.pump.fetchGlobal(),feeConfig=await this.pump.fetchFeeConfig();
      const buy=await this.pump.fetchBuyState(this.mint,user,state.tokenProgram);
      base=getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:new BN(state.mint.supply.toString()),bondingCurve:buy.bondingCurve,amount:quoteBudget,quoteMint:NATIVE_MINT,creatorFeeBps:buy.bondingCurve.creatorFeeBps});
      instructions=await PUMP_SDK.buyInstructions({...buy,global,mint:this.mint,user,amount:base,solAmount:amount,slippage:0,tokenProgram:state.tokenProgram});
    }
    if(base.lten(0))throw new Error('Buyback quote rounds to zero');
    // Exact-output buy + burn are atomic. If the buy or burn fails, neither commits.
    instructions.push(createBurnCheckedInstruction(getAssociatedTokenAddressSync(this.mint,user,true,state.tokenProgram),this.mint,user,BigInt(base.toString()),state.mint.decimals,[],state.tokenProgram));
    details.burned=base.toString();
    return {instructions,details};
  }
  async prepare(job) {
    if(!this.c.live||!this.signer)throw new Error('Execution disabled');
    const balanceNumber=await this.connection.getBalance(this.signer.publicKey,'finalized');
    if(!Number.isSafeInteger(balanceNumber))throw new Error('RPC wallet balance exceeds safe integer range');
    const balance=BigInt(balanceNumber);
    if(balance<BigInt(job.amount)+BigInt(this.c.reserve))throw new Error('Insufficient wallet balance including gas reserve');
    const built=await this.instructions(job);
    const latest=await this.connection.getLatestBlockhash('finalized');
    const instructions=[ComputeBudgetProgram.setComputeUnitLimit({units:500000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:this.c.priorityMicroLamports}),...built.instructions];
    const tx=new VersionedTransaction(new TransactionMessage({payerKey:this.signer.publicKey,recentBlockhash:latest.blockhash,instructions}).compileToV0Message());
    tx.sign([this.signer]);
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
    if(job.kind==='buyback') {
      let spent=0n;
      for(const e of this.decodeEvents(tx)) {
        if(e.name==='tradeevent'&&key(e.data.user)===this.c.creator&&key(e.data.mint)===this.c.mint&&e.data.isBuy) spent+=BigInt(e.data.solAmount.toString())+BigInt(e.data.fee.toString())+BigInt(e.data.creatorFee.toString());
        if(e.name==='buyevent'&&key(e.data.user)===this.c.creator&&key(e.data.pool)===key(canonicalPumpPoolPdaWithQuote(this.mint,NATIVE_MINT))) spent+=BigInt(e.data.userQuoteAmountIn.toString());
      }
      if(spent<=0n||spent>BigInt(job.amount))throw new Error('Buyback receipt amount cannot be reconciled');
      details.spent=String(spent);details.refund=String(BigInt(job.amount)-spent);
    }
    return {tx,details};
  }
}
