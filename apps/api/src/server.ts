import crypto from "node:crypto";
import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { ethers } from "ethers";
import type { WebSocket } from "ws";
import { config } from "./config.js";
import {
  EngineClient,
  EngineError,
  type EngineEvent,
  type EngineResponse,
} from "./engine.js";
import {
  fromPriceTicks,
  fromUnits,
  toPriceTicks,
  toUnits,
  VerificationError,
  verifyOrderSignature,
  type SignedOrder,
} from "./verify.js";

export interface StoredOrder {
  orderId: string;
  symbol: string;
  type: "limit" | "market";
  order: SignedOrder;
  sig: string;
}

export interface RenderedTrade {
  trade_id: number;
  price: string;
  qty: string;
  bid_trader: string;
  ask_trader: string;
  ts: number;
}

export interface Fill {
  bid: SignedOrder;
  ask: SignedOrder;
  bidSig: string;
  askSig: string;
  price: string;
  qty: string;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function tradeEvents(input: EngineResponse | EngineEvent[]): EngineEvent[] {
  const events = Array.isArray(input) ? input : (input.events ?? []);
  return events.filter((e) => e.type === "trade");
}

/** Extract [price, qty] depth pairs from a book response, tolerating the
 *  data living either top-level or inside an event. */
export function extractBook(
  res: EngineResponse,
): { bids: string[][]; asks: string[][] } {
  const rec = res as Record<string, unknown>;
  if (Array.isArray(rec.bids) && Array.isArray(rec.asks)) {
    return { bids: rec.bids as string[][], asks: rec.asks as string[][] };
  }
  for (const e of res.events ?? []) {
    if (Array.isArray(e.bids) && Array.isArray(e.asks)) {
      return { bids: e.bids as string[][], asks: e.asks as string[][] };
    }
  }
  throw new EngineError("engine book response had no bids/asks");
}

export function extractTradesList(res: EngineResponse): EngineEvent[] {
  const rec = res as Record<string, unknown>;
  if (Array.isArray(rec.trades)) return rec.trades as EngineEvent[];
  for (const e of res.events ?? []) {
    if (Array.isArray(e.trades)) return e.trades as EngineEvent[];
  }
  // Fall back to trade events themselves.
  const evts = tradeEvents(res);
  if (evts.length > 0) return evts;
  throw new EngineError("engine trades response had no trades");
}

export function renderTrade(e: EngineEvent): RenderedTrade {
  return {
    trade_id: Number(e.trade_id),
    price: fromPriceTicks(String(e.price)),
    qty: fromUnits(String(e.qty)),
    bid_trader: String(e.bid_trader),
    ask_trader: String(e.ask_trader),
    ts: Number(e.ts),
  };
}

function renderBookPair(pair: string[]): [string, string] {
  return [fromPriceTicks(pair[0]), fromUnits(pair[1])];
}

/**
 * Build settlement fills for unsettled trades. Pure function over the trade
 * events and the in-memory order store, so it is unit-testable without a chain.
 */
export function buildFills(
  trades: EngineEvent[],
  orders: Map<string, StoredOrder>,
  isSettled: (symbol: string, tradeId: number) => boolean,
): { fills: Fill[]; settledKeys: string[] } {
  const fills: Fill[] = [];
  const settledKeys: string[] = [];
  for (const t of trades) {
    const symbol = String(t.symbol);
    const tradeId = Number(t.trade_id);
    const key = `${symbol}:${tradeId}`;
    if (isSettled(symbol, tradeId)) continue;
    const takerIsBid =
      String(t.taker_trader).toLowerCase() === String(t.bid_trader).toLowerCase();
    const bidOrderId = String(takerIsBid ? t.taker_order : t.maker_order);
    const askOrderId = String(takerIsBid ? t.maker_order : t.taker_order);
    const bidStored = orders.get(bidOrderId);
    const askStored = orders.get(askOrderId);
    if (!bidStored || !askStored) continue;
    fills.push({
      bid: bidStored.order,
      ask: askStored.order,
      bidSig: bidStored.sig,
      askSig: askStored.sig,
      price: String(t.price),
      qty: String(t.qty),
    });
    settledKeys.push(key);
  }
  return { fills, settledKeys };
}

export interface ServerHandles {
  app: FastifyInstance;
  engine: EngineClient;
  close: () => Promise<void>;
}

export async function buildServer(opts?: { engineBin?: string }): Promise<ServerHandles> {
  const app = Fastify({ logger: false });
  const engine = new EngineClient(opts?.engineBin);
  engine.start();

  const orders = new Map<string, StoredOrder>();
  const seenNonces = new Map<string, Set<string>>();
  const settledTrades = new Set<string>();
  const knownSymbols = new Set<string>();
  const subscribers = new Map<string, Set<WebSocket>>();
  let orderSeq = 0;

  function isSettled(symbol: string, tradeId: number): boolean {
    return settledTrades.has(`${symbol}:${tradeId}`);
  }

  async function snapshotPayload(symbol: string) {
    const res = await engine.book(symbol, 20);
    const { bids, asks } = extractBook(res);
    return {
      type: "snapshot",
      symbol,
      bids: bids.map(renderBookPair),
      asks: asks.map(renderBookPair),
      ts: nowSeconds(),
    };
  }

  function broadcast(symbol: string, payload: unknown): void {
    const set = subscribers.get(symbol);
    if (!set || set.size === 0) return;
    const text = JSON.stringify(payload);
    for (const socket of [...set]) {
      try {
        if (socket.readyState === socket.OPEN) {
          socket.send(text);
        } else {
          set.delete(socket);
        }
      } catch {
        set.delete(socket);
      }
    }
  }

  /** After a command that produced trades: one snapshot, then one trade
   *  message per trade, to every subscriber of the symbol. */
  async function broadcastTrades(symbol: string, events: EngineEvent[]): Promise<void> {
    const trades = tradeEvents(events);
    if (trades.length === 0) return;
    if (!subscribers.has(symbol)) return;
    try {
      broadcast(symbol, await snapshotPayload(symbol));
    } catch {
      // Snapshot failure must not block trade messages.
    }
    for (const t of trades) {
      broadcast(symbol, { type: "trade", symbol, ...renderTrade(t) });
    }
  }

  function nextOrderId(): string {
    orderSeq += 1;
    return `o-${Date.now().toString(36)}-${orderSeq.toString(36)}${crypto.randomBytes(3).toString("hex")}`;
  }

  function requireAddress(value: unknown, field: string): string {
    if (typeof value !== "string" || !ethers.isAddress(value)) {
      throw new VerificationError(`invalid address for ${field}: ${value}`);
    }
    return value;
  }

  await app.register(websocket);

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const owned = new Set<string>();
    socket.on("message", (raw: Buffer) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        socket.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
        return;
      }
      const m = msg as Record<string, unknown>;
      if (m.type !== "subscribe" || typeof m.symbol !== "string" || m.symbol.length === 0) {
        socket.send(
          JSON.stringify({ type: "error", error: "send {\"type\":\"subscribe\",\"symbol\":\"BASE/QUOTE\"}" }),
        );
        return;
      }
      const symbol = m.symbol;
      let set = subscribers.get(symbol);
      if (!set) {
        set = new Set();
        subscribers.set(symbol, set);
      }
      set.add(socket);
      owned.add(symbol);
      snapshotPayload(symbol).then(
        (snap) => socket.send(JSON.stringify(snap)),
        (err) =>
          socket.send(
            JSON.stringify({ type: "error", error: err instanceof Error ? err.message : String(err) }),
          ),
      );
    });
    const cleanup = () => {
      for (const symbol of owned) {
        subscribers.get(symbol)?.delete(socket);
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  app.post("/api/orders", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const symbol = body.symbol;
      const side = body.side;
      const type = body.type;
      if (typeof symbol !== "string" || symbol.length === 0) {
        throw new VerificationError("symbol is required");
      }
      if (side !== "bid" && side !== "ask") {
        throw new VerificationError('side must be "bid" or "ask"');
      }
      if (type !== "limit" && type !== "market") {
        throw new VerificationError('type must be "limit" or "market"');
      }
      if (typeof body.qty !== "string" || body.qty.length === 0) {
        throw new VerificationError("qty is required");
      }
      const trader = requireAddress(body.trader, "trader");
      const baseToken = requireAddress(body.baseToken, "baseToken");
      const quoteToken = requireAddress(body.quoteToken, "quoteToken");
      if (typeof body.sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(body.sig)) {
        throw new VerificationError("sig must be a 0x hex signature");
      }
      if (body.nonce === undefined || body.nonce === null || String(body.nonce).length === 0) {
        throw new VerificationError("nonce is required");
      }
      if (!/^\d+$/.test(String(body.nonce))) {
        throw new VerificationError("nonce must be a non-negative integer");
      }
      if (!/^\d+$/.test(String(body.expiry))) {
        throw new VerificationError("expiry must be a unix timestamp");
      }
      const expiryNum = Number(body.expiry);
      if (!(expiryNum > nowSeconds())) {
        throw new VerificationError("order is expired");
      }

      const qtyUnits = toUnits(body.qty);
      if (BigInt(qtyUnits) <= 0n) {
        throw new VerificationError("qty must be greater than zero");
      }
      let priceTicks = "0";
      if (type === "limit") {
        if (typeof body.price !== "string" || body.price.length === 0) {
          throw new VerificationError("price is required for limit orders");
        }
        priceTicks = toPriceTicks(body.price);
        if (BigInt(priceTicks) <= 0n) {
          throw new VerificationError("price must be greater than zero");
        }
      }

      const signedOrder: SignedOrder = {
        trader,
        baseToken,
        quoteToken,
        side: side === "bid" ? 0 : 1,
        price: priceTicks,
        qty: qtyUnits,
        nonce: String(body.nonce),
        expiry: String(expiryNum),
      };
      const normalizedTrader = verifyOrderSignature(signedOrder, body.sig);

      // Reserve the nonce before talking to the engine so concurrent
      // duplicate submissions cannot both slip through.
      const nonceKey = normalizedTrader.toLowerCase();
      let used = seenNonces.get(nonceKey);
      if (!used) {
        used = new Set();
        seenNonces.set(nonceKey, used);
      }
      if (used.has(signedOrder.nonce)) {
        throw new VerificationError(`nonce ${signedOrder.nonce} already used`);
      }
      used.add(signedOrder.nonce);

      const orderId = nextOrderId();
      let res: EngineResponse;
      try {
        res = await engine.newOrder({
          symbol,
          order_id: orderId,
          trader: normalizedTrader,
          side,
          type,
          price: priceTicks,
          qty: qtyUnits,
        });
      } catch (err) {
        used.delete(signedOrder.nonce);
        throw err;
      }

      orders.set(orderId, { orderId, symbol, type, order: signedOrder, sig: body.sig });
      knownSymbols.add(symbol);

      const events = res.events ?? [];
      const trades = tradeEvents(events);
      let filled = 0n;
      for (const t of trades) {
        if (String(t.taker_order) === orderId) {
          filled += BigInt(String(t.qty));
        }
      }
      const total = BigInt(qtyUnits);
      const status = filled >= total ? "filled" : filled > 0n ? "partial" : "accepted";

      await broadcastTrades(symbol, events);

      return reply.send({
        order_id: orderId,
        status,
        trades: trades.map(renderTrade),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: message });
    }
  });

  function unknownOrder(err: unknown): boolean {
    return err instanceof EngineError && /unknown order/i.test(err.message);
  }

  app.delete("/api/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as Record<string, unknown>;
    const symbol = query.symbol;
    if (typeof symbol !== "string" || symbol.length === 0) {
      return reply.code(400).send({ error: "query param symbol is required" });
    }
    try {
      await engine.cancel({ symbol, order_id: id });
      return reply.send({ cancelled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(unknownOrder(err) ? 404 : 400).send({ error: message });
    }
  });

  app.patch("/api/orders/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const symbol = body.symbol;
      if (typeof symbol !== "string" || symbol.length === 0) {
        throw new VerificationError("symbol is required");
      }
      const patch: { symbol: string; order_id: string; price?: string; qty?: string } = {
        symbol,
        order_id: id,
      };
      if (body.price !== undefined) {
        if (typeof body.price !== "string" || body.price.length === 0) {
          throw new VerificationError("price must be a decimal string");
        }
        const ticks = toPriceTicks(body.price);
        if (BigInt(ticks) <= 0n) throw new VerificationError("price must be greater than zero");
        patch.price = ticks;
      }
      if (body.qty !== undefined) {
        if (typeof body.qty !== "string" || body.qty.length === 0) {
          throw new VerificationError("qty must be a decimal string");
        }
        const units = toUnits(body.qty);
        if (BigInt(units) <= 0n) throw new VerificationError("qty must be greater than zero");
        patch.qty = units;
      }
      if (patch.price === undefined && patch.qty === undefined) {
        throw new VerificationError("at least one of price or qty is required");
      }
      const res = await engine.amend(patch);
      const stored = orders.get(id);
      if (stored) {
        if (patch.price !== undefined) stored.order.price = patch.price;
        if (patch.qty !== undefined) stored.order.qty = patch.qty;
      }
      await broadcastTrades(symbol, res.events ?? []);
      return reply.send({ amended: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(unknownOrder(err) ? 404 : 400).send({ error: message });
    }
  });

  app.get("/api/book", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const symbol = query.symbol;
    const depth = query.depth === undefined ? 20 : Number(query.depth);
    if (typeof symbol !== "string" || symbol.length === 0) {
      return reply.code(400).send({ error: "query param symbol is required" });
    }
    try {
      const res = await engine.book(symbol, depth);
      const { bids, asks } = extractBook(res);
      return reply.send({
        symbol,
        bids: bids.map(renderBookPair),
        asks: asks.map(renderBookPair),
        ts: nowSeconds(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/trades", async (req, reply) => {
    const query = req.query as Record<string, unknown>;
    const symbol = query.symbol;
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (typeof symbol !== "string" || symbol.length === 0) {
      return reply.code(400).send({ error: "query param symbol is required" });
    }
    try {
      const res = await engine.trades(symbol, limit);
      const list = extractTradesList(res);
      return reply.send({ trades: list.map(renderTrade) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  app.get("/api/health", async (_req, reply) => {
    return reply.send({ ok: true });
  });

  app.post("/api/settle", async (_req, reply) => {
    if (!config.settlerKey) {
      return reply
        .code(500)
        .send({ error: "SETTLER_KEY is not configured, cannot sign settlement transactions" });
    }
    if (/^0x0+$/.test(config.settlementAddress)) {
      return reply
        .code(500)
        .send({ error: "SETTLEMENT_ADDRESS is not configured (zero address)" });
    }
    if (!fs.existsSync(config.settlementArtifact)) {
      return reply.code(500).send({
        error: `Settlement artifact not found at ${config.settlementArtifact}, deploy the contracts first`,
      });
    }
    try {
      const events: EngineEvent[] = [];
      for (const symbol of knownSymbols) {
        try {
          const res = await engine.trades(symbol, 100);
          events.push(...extractTradesList(res));
        } catch {
          // Skip symbols whose trade history is unavailable.
        }
      }
      const { fills, settledKeys } = buildFills(events, orders, isSettled);
      if (fills.length === 0) {
        return reply.send({ tx_hash: null, settled: 0 });
      }
      const artifact = JSON.parse(fs.readFileSync(config.settlementArtifact, "utf8"));
      const provider = new ethers.JsonRpcProvider(config.rpcUrl);
      const signer = new ethers.Wallet(config.settlerKey, provider);
      const settlement = new ethers.Contract(config.settlementAddress, artifact.abi, signer);
      const tx = await settlement.settle(fills);
      const receipt = await tx.wait();
      if (receipt?.status === 0) {
        throw new Error("settle transaction reverted");
      }
      for (const key of settledKeys) settledTrades.add(key);
      return reply.send({ tx_hash: tx.hash, settled: fills.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: message });
    }
  });

  async function close(): Promise<void> {
    try {
      await app.close();
    } finally {
      await engine.kill();
    }
  }

  return { app, engine, close };
}
