'use strict';

require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } = require('@solana/web3.js');
const { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } = require('@solana/spl-token');
const bs58 = require('bs58');

const MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
};

(async () => {
  const secret = process.env.DRAINER_SOL_PRIVATE_KEY;
  if (!secret) throw new Error('set DRAINER_SOL_PRIVATE_KEY in .env (base58)');

  const kp = Keypair.fromSecretKey(bs58.decode(secret));
  console.log('drainer sol wallet:', kp.publicKey.toBase58());

  const expected = process.env.DRAINER_SOL_ADDRESS;
  if (expected && expected !== kp.publicKey.toBase58()) {
    console.warn(`WARNING: DRAINER_SOL_ADDRESS is ${expected} but key derives ${kp.publicKey.toBase58()}`);
  }

  const conn = new Connection(process.env.RPC_SOLANA, 'confirmed');
  const bal = await conn.getBalance(kp.publicKey);
  console.log('drainer SOL balance:', bal / 1e9);
  if (bal < 1e7) console.warn('fund the drainer with at least 0.01 SOL before seeding');

  const tx = new Transaction();
  for (const [sym, mint] of Object.entries(MINTS)) {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), kp.publicKey);
    if (await conn.getAccountInfo(ata)) { console.log(`${sym} ATA already exists`); continue; }
    tx.add(createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, ata, kp.publicKey, new PublicKey(mint)));
    console.log(`${sym} ATA will be created`);
  }

  if (!tx.instructions.length) return console.log('nothing to do');
  console.log('seeded:', await sendAndConfirmTransaction(conn, tx, [kp]));
})().catch((e) => { console.error(e.message); process.exit(1); });