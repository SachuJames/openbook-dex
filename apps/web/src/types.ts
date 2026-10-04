// TypeScript shapes for the OpenBook WebSocket feed and REST responses.
// These mirror the protocol specification exactly.

/** One book level: [price, qty], both human decimal strings, best first. */
export type Level = [string, string];

export interface SnapshotMsg {
  type: "snapshot";
  symbol: string;
  bids: Level[];
  asks: Level[];
  ts: number;
}

export interface TradeMsg {
  type: "trade";
  symbol: string;
  trade_id: number;
  price: string;
  qty: string;
  bid_trader: string;
  ask_trader: string;
  ts: number;
}

export type WsMsg = SnapshotMsg | TradeMsg;

export interface TradeEvent {
  trade_id: number;
  price: string;
  qty: string;
  taker_order?: string;
  maker_order?: string;
  ts?: number;
}

export interface OrderResult {
  order_id: string;
  status: "accepted" | "filled" | "partial";
  trades: TradeEvent[];
}
