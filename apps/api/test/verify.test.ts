import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  ORDER_TYPES,
  VerificationError,
  eip712Domain,
  fromPriceTicks,
  fromUnits,
  recoverOrderSigner,
  toPriceTicks,
  toUnits,
  verifyOrderSignature,
  type SignedOrder,
} from "../src/verify.js";

function makeOrder(trader: string): SignedOrder {
  return {
    trader,
    baseToken: "0x1111111111111111111111111111111111111111",
    quoteToken: "0x2222222222222222222222222222222222222222",
    side: 0,
    price: toPriceTicks("50000.25"),
    qty: toUnits("1.5"),
    nonce: "7",
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
  };
}

describe("unit conversions", () => {
  it("converts qty decimals to smallest units", () => {
    expect(toUnits("1.5")).toBe("1500000000000000000");
    expect(toUnits("10")).toBe("10000000000000000000");
    expect(toUnits("0.000000000000000001")).toBe("1");
    expect(toUnits("0")).toBe("0");
  });

  it("converts price decimals to ticks", () => {
    expect(toPriceTicks("50000.25")).toBe("5000025000000");
    expect(toPriceTicks("50000")).toBe("5000000000000");
    expect(toPriceTicks("0.00000001")).toBe("1");
  });

  it("rounds half up when input exceeds scale", () => {
    expect(toPriceTicks("1.000000005")).toBe("100000001");
    expect(toPriceTicks("1.000000004")).toBe("100000000");
    expect(toUnits("0.0000000000000000005")).toBe("1");
  });

  it("rejects malformed decimals", () => {
    expect(() => toUnits("abc")).toThrow(VerificationError);
    expect(() => toUnits("")).toThrow(VerificationError);
    expect(() => toUnits("1.2.3")).toThrow(VerificationError);
    expect(() => toPriceTicks("-5")).toThrow(VerificationError);
  });

  it("renders integer units back as human decimals", () => {
    expect(fromUnits("1500000000000000000")).toBe("1.5");
    expect(fromUnits("10000000000000000000")).toBe("10");
    expect(fromUnits("1")).toBe("0.000000000000000001");
    expect(fromUnits("0")).toBe("0");
    expect(fromPriceTicks("5000025000000")).toBe("50000.25");
    expect(fromPriceTicks("5000000000000")).toBe("50000");
  });

  it("round-trips human -> integer -> human", () => {
    expect(fromUnits(toUnits("123.456789"))).toBe("123.456789");
    expect(fromPriceTicks(toPriceTicks("9876.54321"))).toBe("9876.54321");
  });
});

describe("EIP-712 order verification", () => {
  it("uses the OpenBook domain", () => {
    const domain = eip712Domain();
    expect(domain.name).toBe("OpenBook");
    expect(domain.version).toBe("1");
    expect(domain.chainId).toBe(31337);
  });

  it("sign-then-verify round trip recovers the trader", async () => {
    const wallet = ethers.Wallet.createRandom();
    const order = makeOrder(wallet.address);
    const sig = await wallet.signTypedData(eip712Domain(), ORDER_TYPES, order);
    const recovered = verifyOrderSignature(order, sig);
    expect(recovered).toBe(ethers.getAddress(wallet.address));
  });

  it("rejects a tampered order", async () => {
    const wallet = ethers.Wallet.createRandom();
    const order = makeOrder(wallet.address);
    const sig = await wallet.signTypedData(eip712Domain(), ORDER_TYPES, order);
    const tampered: SignedOrder = { ...order, qty: toUnits("999") };
    expect(() => verifyOrderSignature(tampered, sig)).toThrow(VerificationError);
  });

  it("rejects a signature from a different wallet", async () => {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const order = makeOrder(wallet.address);
    const sig = await other.signTypedData(eip712Domain(), ORDER_TYPES, order);
    expect(() => verifyOrderSignature(order, sig)).toThrow(VerificationError);
  });

  it("rejects malformed signatures", () => {
    const wallet = ethers.Wallet.createRandom();
    const order = makeOrder(wallet.address);
    expect(() => recoverOrderSigner(order, "0xdeadbeef")).toThrow(VerificationError);
    expect(() => recoverOrderSigner(order, "not-hex")).toThrow(VerificationError);
  });
});
