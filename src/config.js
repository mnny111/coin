import { PublicKey } from '@solana/web3.js';
import { resolve } from 'node:path';

export function config(env = process.env, savedMint, {requireLiveConfig=true} = {}) {
  if(savedMint!==undefined&&savedMint!==null)env={...env,COIN_MINT:savedMint};
  const integer = (key, fallback, min, max) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const amount = (key, fallback) => {
    const value = env[key] ?? fallback;
    if (!/^[0-9]+$/.test(value)) throw new Error(`Invalid ${key}; use integer lamports`);
    return value;
  };
  const address = key => {
    const value = env[key]?.trim();
    if (!value) return null;
    try { return new PublicKey(value).toBase58(); }
    catch { throw new Error('Invalid ' + key + ': use a Solana public address, not a private key, with no surrounding quotes.'); }
  };
  const c = {
    name: 'Coin', db: resolve(env.DATABASE_PATH || 'data/coin.sqlite'),
    port: integer('PORT', 3000, 1, 65535), host: env.HOST || '127.0.0.1',
    rpc: env.SOLANA_RPC_URL || null, mint: address('COIN_MINT'), creator: address('CREATOR_ADDRESS'),
    keyFile: env.SIGNER_KEY_FILE || null, privateKey: env.SIGNER_PRIVATE_KEY?.trim() || null, live: env.EXECUTION_MODE === 'live',
    dedicatedCreator: env.DEDICATED_CREATOR_CONFIRMED === 'true',
    adminPasscode: env.ADMIN_PASSCODE || '',
    nestedFeeWallet: address('NESTED_FEE_WALLET'),
    nestedPrivateKey: env.NESTED_SIGNER_PRIVATE_KEY?.trim() || null,
    start: integer('START_TIME', 0, 0, 9999999999),
    roundSeconds: integer('ROUND_SECONDS', 300, 60, 86400),
    settlementDelay: integer('SETTLEMENT_DELAY_SECONDS', 120, 30, 3600),
    buybackBps: integer('BUYBACK_BPS', 7000, 0, 10000),
    rewardsBps: integer('PAIR_BUYBACK_BPS', 3000, 0, 10000),
    minBuyback: amount('MIN_BUYBACK_LAMPORTS', '10000000'),
    maxBuyback: amount('MAX_BUYBACK_LAMPORTS', '100000000'),
    reserve: amount('GAS_RESERVE_LAMPORTS', '50000000'),
    slippageBps: integer('SLIPPAGE_BPS', 100, 0, 1000),
    interval: integer('POLL_SECONDS', 20, 2, 3600),
    collectSeconds: integer('COLLECT_SECONDS', 300, 60, 86400),
    maxPages: integer('MAX_SCAN_PAGES', 100, 1, 10000),
    priorityMicroLamports: integer('PRIORITY_MICROLAMPORTS', 10000, 0, 1000000),
  };
  if (env.EXECUTION_MODE && !['observe', 'live'].includes(env.EXECUTION_MODE)) throw new Error('Invalid EXECUTION_MODE');
  if (c.buybackBps + c.rewardsBps > 10000) throw new Error('Fee allocations exceed 100%');
  if (BigInt(c.maxBuyback) <= 0n || BigInt(c.maxBuyback) < BigInt(c.minBuyback)) throw new Error('Buyback maximum below minimum');
  if(c.nestedPrivateKey&&!c.nestedFeeWallet)throw new Error('NESTED_SIGNER_PRIVATE_KEY requires NESTED_FEE_WALLET');
  if(c.privateKey&&c.keyFile)throw new Error('Set only one of SIGNER_PRIVATE_KEY or SIGNER_KEY_FILE');
  if (requireLiveConfig && c.live && (!c.rpc || !c.mint || !c.creator || (!c.keyFile&&!c.privateKey) || !c.dedicatedCreator)) throw new Error('Live mode requires RPC, mint, creator, SIGNER_PRIVATE_KEY or SIGNER_KEY_FILE and DEDICATED_CREATOR_CONFIRMED=true');
  return c;
}
