// Central configuration for the OpenBook trading UI.
//
// Change SYMBOL to point the UI at a different market. All endpoints below
// follow the shapes in the OpenBook protocol specification.

export const API_BASE = "http://localhost:3001";
export const WS_URL = "ws://localhost:3001/ws";

// The market shown in the UI. Keep one market for now; changing this
// constant repoints the whole page (subscription, order forms, endpoints).
export const SYMBOL = "BTC/USDC";

export const CHAIN_ID = 31337;

// Settlement contract address. Placeholder zero address until the contract
// is deployed and this is pointed at the real one.
export const SETTLEMENT_ADDRESS = "0x0000000000000000000000000000000000000000";

// Test token addresses. Placeholders until real token contracts are deployed.
export const BASE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000001";
export const QUOTE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000002";

// Human display limits.
export const BOOK_ROWS = 12;
export const TRADE_CAP = 50;

// EIP-712 domain and type definition for Order signing, exactly as the
// protocol defines them. The API and the Settlement contract verify against
// this domain.
export const EIP712_DOMAIN = {
  name: "OpenBook",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: SETTLEMENT_ADDRESS,
} as const;

export const EIP712_TYPES = {
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

// Side encoding for the on-chain Order struct: 0 = bid (buy), 1 = ask (sell).
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

// Scaling constants from the protocol: qty in base smallest units (1e18),
// price as quote per base scaled by 1e8.
export const QTY_DECIMALS = 18;
export const PRICE_DECIMALS = 8;

/**
 * Convert a human decimal string (e.g. "1.5") to integer units as a decimal
 * string, without any floating point math. Extra fractional digits beyond
 * `decimals` are truncated.
 */
export function decimalToUnits(value: string, decimals: number): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: "${value}"`);
  }
  const [intPart, fracRaw = ""] = trimmed.split(".");
  const frac = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(intPart + frac).toString();
}

/** Format a unix timestamp (seconds or milliseconds) as local time. */
export function formatTs(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toLocaleTimeString();
}
