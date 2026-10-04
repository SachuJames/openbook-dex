import { ethers } from "ethers";
import { config } from "./config.js";

export const QTY_DECIMALS = 18;
export const PRICE_DECIMALS = 8;

export interface SignedOrder {
  trader: string;
  baseToken: string;
  quoteToken: string;
  side: 0 | 1; // 0 = bid, 1 = ask
  price: string; // integer string, quote per base scaled 1e8
  qty: string; // integer string, base amount in smallest units
  nonce: string; // integer string
  expiry: string; // integer string, unix seconds
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationError";
  }
}

/**
 * Parse a human decimal string into an integer string scaled by 10^decimals.
 * Uses BigInt math only, rounding half up when the input has more fractional
 * digits than the scale supports. Never uses floats.
 */
export function decimalToUnits(value: string, decimals: number): string {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) {
    throw new VerificationError(`invalid decimal value: ${value}`);
  }
  const v = value.trim();
  const [intPart, fracRaw = ""] = v.split(".");
  const intClean = intPart.replace(/^0+(?=\d)/, "") || "0";
  let frac = fracRaw;
  let carry = 0n;
  if (frac.length > decimals) {
    const kept = frac.slice(0, decimals);
    const nextDigit = Number(frac[decimals]);
    frac = kept;
    if (nextDigit >= 5) carry = 1n;
  }
  while (frac.length < decimals) frac += "0";
  const scaled = BigInt(intClean + frac) + carry;
  return scaled.toString();
}

/** qty decimal -> smallest units (1e18). */
export function toUnits(qtyDecimal: string): string {
  return decimalToUnits(qtyDecimal, QTY_DECIMALS);
}

/** price decimal -> ticks (1e8). */
export function toPriceTicks(priceDecimal: string): string {
  return decimalToUnits(priceDecimal, PRICE_DECIMALS);
}

/**
 * Render an integer string scaled by 10^decimals back as human decimals.
 * Trailing fractional zeros are trimmed: "1500000000000000000" -> "1.5".
 */
export function unitsToDecimal(units: string, decimals: number): string {
  if (typeof units !== "string" || !/^-?\d+$/.test(units.trim())) {
    throw new VerificationError(`invalid integer value: ${units}`);
  }
  const v = units.trim();
  const negative = v.startsWith("-");
  const digits = (negative ? v.slice(1) : v).replace(/^0+(?=\d)/, "") || "0";
  const padded = digits.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "") || "0";
  let fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  const sign = negative && (intPart !== "0" || fracPart !== "") ? "-" : "";
  return fracPart === "" ? `${sign}${intPart}` : `${sign}${intPart}.${fracPart}`;
}

/** smallest units -> human qty decimals. */
export function fromUnits(units: string): string {
  return unitsToDecimal(units, QTY_DECIMALS);
}

/** ticks -> human price decimals. */
export function fromPriceTicks(ticks: string): string {
  return unitsToDecimal(ticks, PRICE_DECIMALS);
}

export function eip712Domain() {
  return {
    name: "OpenBook",
    version: "1",
    chainId: config.chainId,
    verifyingContract: config.settlementAddress,
  };
}

export const ORDER_TYPES: Record<string, Array<{ name: string; type: string }>> = {
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

/**
 * Recover the signer of an EIP-712 order. Throws VerificationError when the
 * signature is malformed.
 */
export function recoverOrderSigner(order: SignedOrder, sig: string): string {
  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(eip712Domain(), ORDER_TYPES, order, sig);
  } catch (err) {
    throw new VerificationError(
      `signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return ethers.getAddress(recovered);
}

/**
 * Verify that sig is a valid EIP-712 signature of `order` by `order.trader`.
 * Returns the normalized trader address on success.
 */
export function verifyOrderSignature(order: SignedOrder, sig: string): string {
  const recovered = recoverOrderSigner(order, sig);
  const expected = ethers.getAddress(order.trader);
  if (recovered !== expected) {
    throw new VerificationError(
      `recovered signer ${recovered} does not match order trader ${expected}`,
    );
  }
  return expected;
}
