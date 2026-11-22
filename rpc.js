'use strict';
// Hardened RPC layer: 10s hard abort per request + automatic endpoint rotation.
// Ethers' default fetch timeout is 300s, which is why a dead public RPC looks
// like a five-minute freeze and then throws TIMEOUT.
const ethers = require('ethers');

const RPC_TIMEOUT = Number(process.env.RPC_TIMEOUT_MS || 10000);
const RETRIES = Number(process.env.RPC_RETRIES || 3);

const RPCS = {
  1:     ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io'],
  56:    ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org', 'https://bsc.drpc.org'],
  137:   ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://1rpc.io/matic'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
  10:    ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
  8453:  ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
  43114: ['https://avalanche-c-chain-rpc.publicnode.com', 'https://api.avax.network/ext/bc/C/rpc'],
};
// optional override / prepend your own node:  RPC_1="https://my-node,https://backup"
for (const id of Object.keys(RPCS)) {
  const extra = (process.env['RPC_' + id] || '').trim();
  if (extra) RPCS[id] = extra.split(',').map((s) => s.trim()).filter(Boolean).concat(RPCS[id]);
}

const ALCHEMY_KEY = (process.env.ALCHEMY_KEY || '').trim();
const ALCHEMY_HOST = { 1: 'eth-mainnet', 56: 'bnb-mainnet', 137: 'polygon-mainnet',
  42161: 'arb-mainnet', 10: 'opt-mainnet', 8453: 'base-mainnet', 43114: 'avax-mainnet' };
const alchemyUrl = (id) => (ALCHEMY_KEY && ALCHEMY_HOST[id])
  ? `https://${ALCHEMY_HOST[id]}.g.alchemy.com/v2/${ALCHEMY_KEY}` : null;

function makeProvider(chainId, url) {
  const req = new ethers.FetchRequest(url);
  req.timeout = RPC_TIMEOUT;                                   // <-- the actual fix
  return new ethers.JsonRpcProvider(req, Number(chainId), {
    staticNetwork: true,                                       // no eth_chainId probe
    polling: 2000,
  });
}

const publicRpc = (chainId) => (RPCS[Number(chainId)] || [])[0] || '';

const urlsFor = (id) => {
  const list = [...(RPCS[id] || [])];
  const a = alchemyUrl(id);
  if (a) list.push(a);
  return list;
};

const _state = new Map(); // id -> { provider, index, pending }
function state(id) {
  let s = _state.get(id);
  if (!s) { s = { provider: null, index: 0, pending: null }; _state.set(id, s); }
  return s;
}

async function pick(id, startAt = 0) {
  const urls = urlsFor(id);
  if (!urls.length) throw new Error(`no RPC configured for chain ${id}`);
  let last;
  for (let n = 0; n < urls.length; n++) {
    const i = (startAt + n) % urls.length;
    try {
      const p = makeProvider(id, urls[i]);
      await p.getBlockNumber();
      const s = state(id);
      s.provider = p; s.index = i;
      console.log(`[rpc] chain ${id} -> ${urls[i]}`);
      return p;
    } catch (e) {
      last = e;
      console.warn(`[rpc] chain ${id} dead: ${urls[i]} (${e.shortMessage || e.message})`);
    }
  }
  throw last || new Error(`no live RPC for chain ${id}`);
}

async function ensure(id, rotateFirst = false) {
  const s = state(id);
  if (s.provider && !rotateFirst) return s.provider;
  if (s.pending) await s.pending;
  if (state(id).provider && !rotateFirst) return state(id).provider;
  s.pending = pick(id, rotateFirst ? s.index + 1 : 0)
    .catch(() => state(id).provider)
    .finally(() => { state(id).pending = null; });
  await s.pending;
  return state(id).provider;
}

// Every provider method becomes retrying + endpoint-rotating.
// Non-thenable, so both `getLiveProvider(id)` and `await getLiveProvider(id)` work.
function wrap(id) {
  const s = state(id);
  return new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (prop === '_isProvider') return true;
      if (prop === '_isSigner') return false;
      const cur = s.provider;
      if (cur) {
        const v = cur[prop];
        if (typeof v !== 'function') return v;
      }
      return (...args) => invoke(id, prop, args);
    },
    set(_t, prop, value) { if (s.provider) s.provider[prop] = value; return true; },
  });
}

async function invoke(id, prop, args) {
  let last;
  for (let i = 0; i < RETRIES; i++) {
    let cur = state(id).provider;
    if (!cur) cur = await ensure(id, true);
    if (!cur) continue;
    try {
      return await cur[prop](...args);
    } catch (e) {
      last = e;
      if (e.code === 'CALL_EXCEPTION' || e.code === 'ACTION_REJECTED') throw e;
      console.warn(`[rpc] chain ${id}.${prop} failed: ${e.shortMessage || e.message}`);
      state(id).provider = null;   // rotate on next loop
    }
  }
  throw last;
}

// SYNC on purpose: returns a proxy immediately, connects lazily.
function getLiveProvider(chainId) {
  const id = Number(chainId);
  const s = state(id);
  if (!s.provider) {
    const urls = urlsFor(id);
    if (!urls.length) throw new Error(`no RPC configured for chain ${id}`);
    s.provider = makeProvider(id, urls[0]);
    ensure(id).catch(() => {});
  }
  return wrap(id);
}

async function rpc(chainId, fn, tries = RETRIES) {
  const id = Number(chainId);
  let last;
  for (let i = 0; i < tries; i++) {
    let cur = state(id).provider || await ensure(id, true);
    if (!cur) continue;
    try { return await fn(cur); }
    catch (e) {
      last = e;
      if (e.code === 'CALL_EXCEPTION' || e.code === 'ACTION_REJECTED') throw e;
      state(id).provider = null;
    }
  }
  throw last;
}

module.exports = { RPCS, CHAIN_RPCS: RPCS, RPC_TIMEOUT, makeProvider, publicRpc, urlsFor, getLiveProvider, rpc };