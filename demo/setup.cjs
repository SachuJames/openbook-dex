// Funds the two demo traders on the local chain: mints test tokens, approves
// the vault, and deposits. Uses Hardhat's public local test keys (demo only,
// never real funds).
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const VAULT = process.env.VAULT_ADDRESS;
const BASE = process.env.BASE_TOKEN;
const QUOTE = process.env.QUOTE_TOKEN;
const MAKER_KEY = process.env.MAKER_KEY;
const TAKER_KEY = process.env.TAKER_KEY;

if (!VAULT || !BASE || !QUOTE || !MAKER_KEY || !TAKER_KEY) {
  console.error("missing env: VAULT_ADDRESS BASE_TOKEN QUOTE_TOKEN MAKER_KEY TAKER_KEY");
  process.exit(1);
}

const ERC20_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const VAULT_ABI = [
  "function deposit(address token, uint256 amount)",
  "function balanceOf(address user, address token) view returns (uint256)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const maker = new ethers.Wallet(MAKER_KEY, provider);
  const taker = new ethers.Wallet(TAKER_KEY, provider);

  const base = new ethers.Contract(BASE, ERC20_ABI, provider);
  const quote = new ethers.Contract(QUOTE, ERC20_ABI, provider);
  const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);

  // Explicit nonces: avoids any race between send and automine.
  let makerNonce = await provider.getTransactionCount(maker.address);
  let takerNonce = await provider.getTransactionCount(taker.address);
  const send = async (contract, signer, nonce, method, ...args) => {
    const tx = await contract.connect(signer)[method](...args, { nonce });
    await tx.wait();
  };

  // Mint: 10 base to the maker (seller), 100000 quote to the taker (buyer).
  await send(base, maker, makerNonce++, "mint", maker.address, ethers.parseUnits("10", 18));
  await send(quote, taker, takerNonce++, "mint", taker.address, ethers.parseUnits("100000", 18));

  // Approve and deposit everything into the vault.
  await send(base, maker, makerNonce++, "approve", VAULT, ethers.parseUnits("10", 18));
  await send(vault, maker, makerNonce++, "deposit", BASE, ethers.parseUnits("10", 18));
  await send(quote, taker, takerNonce++, "approve", VAULT, ethers.parseUnits("100000", 18));
  await send(vault, taker, takerNonce++, "deposit", QUOTE, ethers.parseUnits("100000", 18));

  const mb = await vault.balanceOf(maker.address, BASE);
  const tq = await vault.balanceOf(taker.address, QUOTE);
  console.log("maker base in vault:  " + ethers.formatUnits(mb, 18));
  console.log("taker quote in vault: " + ethers.formatUnits(tq, 18));
}

main().catch((e) => { console.error(e); process.exit(1); });
