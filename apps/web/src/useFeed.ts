import { useEffect, useRef, useState } from "react";
import { SYMBOL, TRADE_CAP, WS_URL } from "./config";
import type { SnapshotMsg, TradeMsg, WsMsg } from "./types";

export type ConnState = "connecting" | "live" | "closed";

/**
 * Connects to the OpenBook WebSocket feed, subscribes to SYMBOL with
 * {"type": "subscribe", "symbol": SYMBOL}, and tracks the latest full depth
 * snapshot plus the recent trades list (newest first, capped at TRADE_CAP).
 * Reconnects automatically with a short delay if the socket drops.
 */
export function useFeed() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [snapshot, setSnapshot] = useState<SnapshotMsg | null>(null);
  const [trades, setTrades] = useState<TradeMsg[]>([]);
  const tradesRef = useRef<TradeMsg[]>([]);
  tradesRef.current = trades;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: number | undefined;
    let stopped = false;

    const connect = () => {
      setConn("connecting");
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: "subscribe", symbol: SYMBOL }));
      };

      ws.onmessage = (ev) => {
        let msg: WsMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.symbol !== SYMBOL) return;
        if (msg.type === "snapshot") {
          setConn("live");
          setSnapshot(msg);
        } else if (msg.type === "trade") {
          setConn("live");
          setTrades((prev) => [msg, ...prev].slice(0, TRADE_CAP));
        }
      };

      ws.onclose = () => {
        if (stopped) return;
        setConn("closed");
        timer = window.setTimeout(connect, 2000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, []);

  return { conn, snapshot, trades };
}
