import { PublicKey } from '@solana/web3.js';
import { PUMP_SDK, PUMP_FEE_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, feeSharingConfigPda, bondingCurvePda, canonicalPumpPoolPdaWithQuote } from '@pump-fun/pump-sdk';
import { PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';

const key=value=>value?.toBase58?.()??String(value);
export function fullFeeShare(shareholders,wallet) {
  return !!wallet&&Array.isArray(shareholders)&&shareholders.length===1&&key(shareholders[0].address)===wallet&&Number(shareholders[0].shareBps)===10000;
}
export async function verifyNestedPair(chain,pair,wallet) {
  if(!wallet)return false;
  const mint=new PublicKey(pair.mint),parent=new PublicKey(pair.parent_mint),sharing=feeSharingConfigPda(mint);
  const [configInfo,curveInfo,poolInfo]=await chain.connection.getMultipleAccountsInfo([sharing,bondingCurvePda(mint),canonicalPumpPoolPdaWithQuote(mint,parent)],'finalized');
  if(!configInfo?.owner.equals(PUMP_FEE_PROGRAM_ID)||!curveInfo?.owner.equals(PUMP_PROGRAM_ID))return false;
  const config=PUMP_SDK.decodeSharingConfig(configInfo),curve=PUMP_SDK.decodeBondingCurve(curveInfo);
  if(!config.mint.equals(mint)||!fullFeeShare(config.shareholders,wallet)||!curve.creator.equals(sharing)||!curve.quoteMint.equals(parent))return false;
  if(poolInfo){
    if(!poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID))return false;
    const pool=PUMP_AMM_SDK.decodePool(poolInfo);
    if(!pool.baseMint.equals(mint)||!pool.quoteMint.equals(parent)||!pool.coinCreator.equals(sharing))return false;
  } else if(curve.complete)return false;
  return true;
}
