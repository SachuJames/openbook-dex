import { describe, expect, it } from "vitest";
import { buildFills, type StoredOrder } from "../src/server.js";
import type { EngineEvent } from "../src/engine.js";

function stored(
  orderId: string,
  side: 0 | 1,
  sig: string,
): StoredOrder {
  return {
    orderId,
    symbol: "BTC/USDC",
    type: "limit",
    order: {
      trader: side === 0 ? "0xB1d00000000000000000000000000000000000001" : "0xA5k00000000000000000000000000000000000001",
      baseToken: "0x1111111111111111111111111111111111111111",
      quoteToken: "0x2222222222222222222222222222222222222222",
      side,
      price: "5000000000000",
      qty: "1000000000000000000",
      nonce: "1",
      expiry: "1893456000",
    },
    sig,
  };
}

describe("buildFills", () => {
  it("builds fills from stored bid and ask orders", () => {
    const orders = new Map<string, StoredOrder>([
      ["o-bid", stored("o-bid", 0, "0xbid")],
      ["o-ask", stored("o-ask", 1, "0xask")],
    ]);
    const trades: EngineEvent[] = [
      {
        type: "trade",
        trade_id: 7,
        symbol: "BTC/USDC",
        price: "5000000000000",
        qty: "500000000000000000",
        taker_order: "o-ask",
        maker_order: "o-bid",
        taker_trader: "0xA5k00000000000000000000000000000000000001",
        maker_trader: "0xB1d00000000000000000000000000000000000001",
        bid_trader: "0xB1d00000000000000000000000000000000000001",
        ask_trader: "0xA5k00000000000000000000000000000000000001",
        ts: 1728000000,
      },
    ];
    const { fills, settledKeys } = buildFills(trades, orders, () => false);
    expect(fills).toHaveLength(1);
    expect(fills[0].bid.side).toBe(0);
    expect(fills[0].ask.side).toBe(1);
    expect(fills[0].bidSig).toBe("0xbid");
    expect(fills[0].askSig).toBe("0xask");
    expect(fills[0].price).toBe("5000000000000");
    expect(fills[0].qty).toBe("500000000000000000");
    expect(settledKeys).toEqual(["BTC/USDC:7"]);
  });

  it("identifies the bid side when the taker is the buyer", () => {
    const orders = new Map<string, StoredOrder>([
      ["o-bid", stored("o-bid", 0, "0xbid")],
      ["o-ask", stored("o-ask", 1, "0xask")],
    ]);
    const trades: EngineEvent[] = [
      {
        type: "trade",
        trade_id: 8,
        symbol: "BTC/USDC",
        price: "5000000000000",
        qty: "100000000000000000",
        taker_order: "o-bid",
        maker_order: "o-ask",
        taker_trader: "0xB1d00000000000000000000000000000000000001",
        maker_trader: "0xA5k00000000000000000000000000000000000001",
        bid_trader: "0xB1d00000000000000000000000000000000000001",
        ask_trader: "0xA5k00000000000000000000000000000000000001",
        ts: 1728000000,
      },
    ];
    const { fills } = buildFills(trades, orders, () => false);
    expect(fills).toHaveLength(1);
    expect(fills[0].bidSig).toBe("0xbid");
    expect(fills[0].askSig).toBe("0xask");
  });

  it("skips already-settled trades and trades with missing orders", () => {
    const orders = new Map<string, StoredOrder>([["o-bid", stored("o-bid", 0, "0xbid")]]);
    const base = {
      type: "trade",
      symbol: "BTC/USDC",
      price: "5000000000000",
      qty: "100000000000000000",
      taker_order: "o-bid",
      maker_order: "o-ask",
      taker_trader: "0xB1d00000000000000000000000000000000000001",
      maker_trader: "0xA5k00000000000000000000000000000000000001",
      bid_trader: "0xB1d00000000000000000000000000000000000001",
      ask_trader: "0xA5k00000000000000000000000000000000000001",
      ts: 1728000000,
    };
    const trades: EngineEvent[] = [
      { ...base, trade_id: 9 },
      { ...base, trade_id: 10 },
    ];
    // trade 9 is settled, trade 10 references a missing ask order.
    const { fills, settledKeys } = buildFills(
      trades,
      orders,
      (_symbol, tradeId) => tradeId === 9,
    );
    expect(fills).toHaveLength(0);
    expect(settledKeys).toHaveLength(0);
  });
});
