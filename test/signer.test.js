import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@solana/web3.js';
import bs58 from 'bs58';
import {config} from '../src/config.js';
import {Chain} from '../src/chain.js';
const signer=Keypair.generate();
function settings(extra={}){return config({EXECUTION_MODE:'live',SOLANA_RPC_URL:'http://127.0.0.1:8899',COIN_MINT:Keypair.generate().publicKey.toBase58(),CREATOR_ADDRESS:signer.publicKey.toBase58(),START_TIME:'100',DEDICATED_CREATOR_CONFIRMED:'true',SIGNER_PRIVATE_KEY:bs58.encode(signer.secretKey),...extra});}
test('live signer loads an exported base58 private key for the configured creator',()=>{const chain=new Chain(settings());assert.ok(chain.signer.publicKey.equals(signer.publicKey));});
test('a different wallet cannot sign creator operations',()=>{assert.throws(()=>new Chain(settings({CREATOR_ADDRESS:Keypair.generate().publicKey.toBase58()})),/dedicated creator wallet/);});
test('malformed keys, public addresses and recovery phrases are rejected without echoing secrets',()=>{for(const value of ['private-key-invalid-secret',signer.publicKey.toBase58(),'word '.repeat(12),bs58.encode(new Uint8Array(64))]){assert.throws(()=>new Chain(settings({SIGNER_PRIVATE_KEY:value})),error=>error.message.startsWith('Invalid signer:')&&!error.message.includes(value));}});
test('observation mode does not parse or load the signing key',()=>{const chain=new Chain(settings({EXECUTION_MODE:'observe',SIGNER_PRIVATE_KEY:'invalid'}));assert.equal(chain.signer,undefined);});
test('ambiguous signer sources are rejected',()=>{assert.throws(()=>settings({SIGNER_KEY_FILE:'key.json'}),/Set only one/);});
test('separate nested signer must match its own fee wallet',()=>{
 const nested=Keypair.generate(),encoded=bs58.encode(nested.secretKey);
 const chain=new Chain(settings({NESTED_FEE_WALLET:nested.publicKey.toBase58(),NESTED_SIGNER_PRIVATE_KEY:encoded}));assert.ok(chain.nestedSigner.publicKey.equals(nested.publicKey));assert.ok(chain.signer.publicKey.equals(signer.publicKey));
 assert.throws(()=>new Chain(settings({NESTED_FEE_WALLET:signer.publicKey.toBase58(),NESTED_SIGNER_PRIVATE_KEY:encoded})),/Nested signer must match/);
});
test('nested signer credentials stay unused in observation mode and invalid values are not echoed',()=>{
 const wallet=Keypair.generate().publicKey.toBase58();const c=settings({EXECUTION_MODE:'observe',NESTED_FEE_WALLET:wallet,NESTED_SIGNER_PRIVATE_KEY:'invalid-secret'});assert.equal(new Chain(c).nestedSigner,undefined);
 assert.throws(()=>new Chain({...c,live:true}),error=>error.message.startsWith('Invalid nested signer:')&&!error.message.includes('invalid-secret'));
 assert.throws(()=>settings({NESTED_SIGNER_PRIVATE_KEY:'invalid-secret'}),/requires NESTED_FEE_WALLET/);
});
