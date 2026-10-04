import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ethers } from "ethers";
import { WebSocket } from "ws";
import { buildServer, type ServerHandles } from "../src/server.js";
import { ORDER_TYPES, eip712Domain, toPriceTicks, toUnits } from "../src/verify.js";
import { ensureEngineBinary } from "./helpers/engineSetup.js";

const BASE_TOKEN = "0x1111111111111111111111111111111111111111";
const QUOTE_TOKEN = "0x2222222222222222222222222222222222222222";

let handles: ServerHandles;
let baseUrl: string;
let wsUrl: string;

type TestWallet = ethers.HDNodeWallet;
const nonces = new Map<string, number>();
function nextNonce(wallet: TestWallet): string {
  const n = (nonces.get(wallet.address) ?? 0) + 1;
  nonces.set(wallet.address, n);
  return String(n);
}

interface OrderBody {
  symbol: string;
  side: "bid" | "ask";
  type: "limit" | "market";
  price?: string;
  qty: string;
  trader: string;
  sig: string;
  baseToken: string;
  quoteToken: string;
  nonce: string;
  expiry: number;
}

async function signedOrder(
  wallet: TestWallet,
  fields: {
    symbol?: string;
    side: "bid" | "ask";
    type?: "limit" | "market";
    price?: string;
    qty: string;
    nonce?: string;
    expiry?: number;
  },
): Promise<OrderBody> {
  const sideNum = fields.side === "bid" ? 0 : 1;
  const priceTicks = fields.type === "market" ? "0" : toPriceTicks(fields.price ?? "0");
  const order = {
    trader: wallet.address,
    baseToken: BASE_TOKEN,
    quoteToken: QUOTE_TOKEN,
    side: sideNum,
    price: priceTicks,
    qty: toUnits(fields.qty),
    nonce: fields.nonce ?? nextNonce(wallet),
    expiry: String(fields.expiry ?? Math.floor(Date.now() / 1000) + 3600),
  };
  const sig = await wallet.signTypedData(eip712Domain(), ORDER_TYPES, order);
  return {
    symbol: fields.symbol ?? "BTC/USDC",
    side: fields.side,
    type: fields.type ?? "limit",
    ...(fields.type === "market" ? {} : { price: fields.price }),
    qty: fields.qty,
    trader: wallet.address,
    sig,
    baseToken: BASE_TOKEN,
    quoteToken: QUOTE_TOKEN,
    nonce: order.nonce,
    expiry: Number(order.expiry),
  };
}

async function postOrder(body: OrderBody) {
  const res = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

function waitForMessage(
  socket: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("timed out waiting for websocket message"));
    }, timeoutMs);
    const onMessage = (raw: Buffer) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        socket.off("message", onMessage);
        resolve(msg);
      }
    };
    socket.on("message", onMessage);
  });
}

beforeAll(async () => {
  const bin = await ensureEngineBinary();
  handles = await buildServer({ engineBin: bin });
  await handles.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = handles.app.server.address();
  if (!addr || typeof addr === "string") throw new Error("failed to listen");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  expect(await handles.engine.ping()).toBe(true);
}, 600000);

afterAll(async () => {
  await handles?.close();
});

describe("REST order flow against the real engine", () => {
  const maker = ethers.Wallet.createRandom();
  const taker = ethers.Wallet.createRandom();

  it("accepts a resting limit bid", async () => {
    const { status, json } = await postOrder(
      await signedOrder(maker, { side: "bid", price: "50000", qty: "1.5" }),
    );
    expect(status).toBe(200);
    expect(json.status).toBe("accepted");
    expect(json.trades).toEqual([]);
    expect(typeof json.order_id).toBe("string");
  });

  it("matches a crossing ask and reports a fill", async () => {
    const { status, json } = await postOrder(
      await signedOrder(taker, { side: "ask", price: "49000", qty: "0.5" }),
    );
    expect(status).toBe(200);
    expect(json.status).toBe("filled");
    expect(json.trades).toHaveLength(1);
    const trade = json.trades[0];
    expect(trade.price).toBe("50000");
    expect(trade.qty).toBe("0.5");
    expect(trade.bid_trader).toBe(ethers.getAddress(maker.address));
    expect(trade.ask_trader).toBe(ethers.getAddress(taker.address));
  });

  it("exposes the trade in GET /api/trades with human decimals", async () => {
    const res = await fetch(`${baseUrl}/api/trades?symbol=BTC/USDC&limit=50`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.trades).toHaveLength(1);
    expect(json.trades[0].price).toBe("50000");
    expect(json.trades[0].qty).toBe("0.5");
  });

  it("shows the reduced book in GET /api/book", async () => {
    const res = await fetch(`${baseUrl}/api/book?symbol=BTC/USDC&depth=20`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.symbol).toBe("BTC/USDC");
    expect(json.bids).toEqual([["50000", "1"]]);
    expect(json.asks).toEqual([]);
  });

  it("reports a partial fill when the order is larger than the book", async () => {
    const seller = ethers.Wallet.createRandom();
    const buyer = ethers.Wallet.createRandom();
    const r1 = await postOrder(
      await signedOrder(seller, { symbol: "ETH/USDC", side: "ask", price: "3000", qty: "0.5" }),
    );
    expect(r1.json.status).toBe("accepted");
    const r2 = await postOrder(
      await signedOrder(buyer, { symbol: "ETH/USDC", side: "bid", type: "market", qty: "1" }),
    );
    expect(r2.status).toBe(200);
    expect(r2.json.status).toBe("partial");
    expect(r2.json.trades).toHaveLength(1);
    expect(r2.json.trades[0].qty).toBe("0.5");
  });

  it("cancels a resting order, then 404s on the second cancel", async () => {
    const w = ethers.Wallet.createRandom();
    const placed = await postOrder(
      await signedOrder(w, { side: "ask", price: "60000", qty: "1" }),
    );
    expect(placed.json.status).toBe("accepted");
    const orderId = placed.json.order_id as string;

    const del1 = await fetch(`${baseUrl}/api/orders/${orderId}?symbol=BTC/USDC`, {
      method: "DELETE",
    });
    expect(del1.status).toBe(200);
    expect((await del1.json()).cancelled).toBe(true);

    const del2 = await fetch(`${baseUrl}/api/orders/${orderId}?symbol=BTC/USDC`, {
      method: "DELETE",
    });
    expect(del2.status).toBe(404);
  });

  it("amends a resting order price", async () => {
    const w = ethers.Wallet.createRandom();
    const placed = await postOrder(
      await signedOrder(w, { side: "bid", price: "49000", qty: "1" }),
    );
    const orderId = placed.json.order_id as string;
    const res = await fetch(`${baseUrl}/api/orders/${orderId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "BTC/USDC", price: "49500" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).amended).toBe(true);

    const book = await (await fetch(`${baseUrl}/api/book?symbol=BTC/USDC`)).json();
    expect(book.bids).toContainEqual(["49500", "1"]);
    expect(book.bids[0]).toEqual(["50000", "1"]);
  });
});

describe("order validation", () => {
  it("rejects a bad signature with 400", async () => {
    const wallet = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const body = await signedOrder(wallet, { side: "bid", price: "50000", qty: "0.1" });
    body.trader = other.address; // signature no longer matches trader
    const { status, json } = await postOrder(body);
    expect(status).toBe(400);
    expect(typeof json.error).toBe("string");
  });

  it("rejects a reused nonce with 400", async () => {
    const wallet = ethers.Wallet.createRandom();
    const first = await postOrder(
      await signedOrder(wallet, { side: "bid", price: "48000", qty: "0.1", nonce: "42" }),
    );
    expect(first.status).toBe(200);
    const second = await postOrder(
      await signedOrder(wallet, { side: "bid", price: "48000", qty: "0.1", nonce: "42" }),
    );
    expect(second.status).toBe(400);
    expect(second.json.error).toMatch(/nonce/i);
  });

  it("rejects an expired order with 400", async () => {
    const wallet = ethers.Wallet.createRandom();
    const { status, json } = await postOrder(
      await signedOrder(wallet, {
        side: "bid",
        price: "48000",
        qty: "0.1",
        expiry: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    expect(status).toBe(400);
    expect(json.error).toMatch(/expired/i);
  });

  it("answers GET /api/health", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("settle endpoint guards", () => {
  it("returns a clear error when settlement is not configured", async () => {
    const res = await fetch(`${baseUrl}/api/settle`, { method: "POST" });
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
    expect(json.error).toMatch(/SETTLER_KEY|SETTLEMENT_ADDRESS|artifact/);
  });
});

describe("websocket market data against the real engine", () => {
  it("sends a snapshot on subscribe and trade messages on match", async () => {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });

    const snapshotPromise = waitForMessage(socket, (m) => m.type === "snapshot");
    socket.send(JSON.stringify({ type: "subscribe", symbol: "BTC/USDC" }));
    const snapshot = (await snapshotPromise) as Record<string, unknown>;
    expect(snapshot.symbol).toBe("BTC/USDC");
    expect(Array.isArray(snapshot.bids)).toBe(true);
    expect(Array.isArray(snapshot.asks)).toBe(true);

    // Resting best bid is 50000; a crossing ask must trigger a trade.
    const trader = ethers.Wallet.createRandom();
    const tradePromise = waitForMessage(
      socket,
      (m) => m.type === "trade" && m.symbol === "BTC/USDC",
    );
    const placed = await postOrder(
      await signedOrder(trader, { side: "ask", price: "50000", qty: "0.25" }),
    );
    expect(placed.json.status).toBe("filled");
    const tradeMsg = await tradePromise;
    expect(tradeMsg.price).toBe("50000");
    expect(tradeMsg.qty).toBe("0.25");
    expect(tradeMsg.bid_trader).toBeDefined();
    expect(tradeMsg.ask_trader).toBe(ethers.getAddress(trader.address));

    socket.close();
  });

  it("serializes concurrent engine requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => handles.engine.ping()),
    );
    expect(results).toEqual([true, true, true, true, true]);
  });
});
