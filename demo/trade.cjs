// Places signed orders through the API, settles the resulting trade on-chain,
// and verifies vault balances before and after. Uses Hardhat's public local
// test keys (demo only).
const { ethers } = require("ethers");

const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";
const API = process.env.API_BASE || "http://127.0.0.1:3001";
const SETTLEMENT = process.env.SETTLEMENT_ADDRESS;
const VAULT = process.env.VAULT_ADDRESS;
const BASE = process.env.BASE_TOKEN;
const QUOTE = process.env.QUOTE_TOKEN;
const MAKER_KEY = process.env.MAKER_KEY;
const TAKER_KEY = process.env.TAKER_KEY;
const CHAIN_ID = 31337;
const SYMBOL = "BTC/USDC";

if (!SETTLEMENT || !VAULT || !BASE || !QUOTE || !MAKER_KEY || !TAKER_KEY) {
  console.error("missing env");
  process.exit(1);
}

const VAULT_ABI = ["function balanceOf(address user, address token) view returns (uint256)"];

const DOMAIN = { name: "OpenBook", version: "1", chainId: CHAIN_ID, verifyingContract: SETTLEMENT };
const TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "baseToken", type: "address" },
    { name: "quoteToken", type: "address" },
    { name: "side", type: "uint8" },
    { name: "price", type: "uint256" },
    { name: "qty", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

const toUnits = (d) => (BigInt(Math.round(parseFloat(d) * 1e6)) * 10n ** 12n).toString();
const toTicks = (d) => (BigInt(Math.round(parseFloat(d) * 1e6)) * 100n).toString();

async function post(path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error("POST " + path + " -> " + r.status + " " + JSON.stringify(j));
  return j;
}

async function balances(provider) {
  const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);
  const maker = new ethers.Wallet(MAKER_KEY).address;
  const taker = new ethers.Wallet(TAKER_KEY).address;
  return {
    makerBase: await vault.balanceOf(maker, BASE),
    makerQuote: await vault.balanceOf(maker, QUOTE),
    takerBase: await vault.balanceOf(taker, BASE),
    takerQuote: await vault.balanceOf(taker, QUOTE),
  };
}

function fmt(b) { return ethers.formatUnits(b, 18); }

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const maker = new ethers.Wallet(MAKER_KEY, provider);
  const taker = new ethers.Wallet(TAKER_KEY, provider);
  const expiry = Math.floor(Date.now() / 1000) + 3600;

  const before = await balances(provider);
  console.log("balances before:");
  console.log("  maker: " + fmt(before.makerBase) + " base, " + fmt(before.makerQuote) + " quote");
  console.log("  taker: " + fmt(before.takerBase) + " base, " + fmt(before.takerQuote) + " quote");

  // Maker asks 1.0 base at 50000 quote.
  const askOrder = {
    trader: maker.address, baseToken: BASE, quoteToken: QUOTE, side: 1,
    price: toTicks("50000"), qty: toUnits("1.0"), nonce: 1, expiry,
  };
  const askSig = await maker.signTypedData(DOMAIN, TYPES, askOrder);
  const askRes = await post("/api/orders", {
    symbol: SYMBOL, side: "ask", type: "limit", price: "50000", qty: "1.0",
    trader: maker.address, sig: askSig, baseToken: BASE, quoteToken: QUOTE,
    nonce: 1, expiry,
  });
  console.log("ask placed: " + askRes.order_id + " (" + askRes.status + ")");

  // Taker bids 0.5 base at 51000, crossing the ask.
  const bidOrder = {
    trader: taker.address, baseToken: BASE, quoteToken: QUOTE, side: 0,
    price: toTicks("51000"), qty: toUnits("0.5"), nonce: 1, expiry,
  };
  const bidSig = await taker.signTypedData(DOMAIN, TYPES, bidOrder);
  const bidRes = await post("/api/orders", {
    symbol: SYMBOL, side: "bid", type: "limit", price: "51000", qty: "0.5",
    trader: taker.address, sig: bidSig, baseToken: BASE, quoteToken: QUOTE,
    nonce: 1, expiry,
  });
  console.log("bid placed: " + bidRes.order_id + " (" + bidRes.status + ")");
  for (const t of bidRes.trades || []) {
    console.log("trade: " + t.qty + " @ " + t.price + " (trade_id " + t.trade_id + ")");
  }
  if (!bidRes.trades || bidRes.trades.length === 0) throw new Error("expected a trade");

  // Settle on-chain.
  const settleRes = await post("/api/settle", {});
  console.log("settled on-chain: tx " + settleRes.tx_hash + " (" + settleRes.settled + " fills)");

  const after = await balances(provider);
  console.log("balances after:");
  console.log("  maker: " + fmt(after.makerBase) + " base, " + fmt(after.makerQuote) + " quote");
  console.log("  taker: " + fmt(after.takerBase) + " base, " + fmt(after.takerQuote) + " quote");

  // Expected: 0.5 base sold at 50000 -> maker -0.5 base, +25000 quote;
  // taker +0.5 base, -25000 quote.
  const d = (a, b) => a - b;
  const ok =
    d(before.makerBase, after.makerBase) === ethers.parseUnits("0.5", 18) &&
    d(after.makerQuote, before.makerQuote) === ethers.parseUnits("25000", 18) &&
    d(after.takerBase, before.takerBase) === ethers.parseUnits("0.5", 18) &&
    d(before.takerQuote, after.takerQuote) === ethers.parseUnits("25000", 18);
  if (!ok) throw new Error("balance assertions failed");
  console.log("demo checks passed: trade matched off-chain and settled on-chain");
}

main().catch((e) => { console.error("demo failed: " + e.message); process.exit(1); });
