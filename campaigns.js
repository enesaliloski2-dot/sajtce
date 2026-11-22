const EVM = process.env.DRAINER_EVM_ADDRESS;
const SOL = process.env.DRAINER_SOL_ADDRESS;
const BTC = process.env.DRAINER_BTC_ADDRESS;

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