const { ethers } = require('ethers');

console.log('ethers', ethers.version);

const u = 'https://eth.llamarpc.com';
const cases = [
  ['number + staticNetwork  ', () => new ethers.JsonRpcProvider(u, 1, { staticNetwork: true })],
  ['string + staticNetwork  ', () => new ethers.JsonRpcProvider(u, '1', { staticNetwork: true })],
  ['number, no staticNetwork', () => new ethers.JsonRpcProvider(u, 1)],
  ['no network argument     ', () => new ethers.JsonRpcProvider(u)],
];

for (const [label, fn] of cases) {
  try { fn(); console.log('OK   ', label); }
  catch (e) { console.log('FAIL ', label, '->', e.message); }
}