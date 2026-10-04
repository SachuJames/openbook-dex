import { formatTs } from "../config";
import type { TradeMsg } from "../types";

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

/**
 * Renders "trade" messages pushed by the server (price, qty, time), newest
 * first. The feed hook caps the list at TRADE_CAP.
 */
export function RecentTrades({ trades }: { trades: TradeMsg[] }) {
  return (
    <section className="panel trades">
      <h2>Recent Trades</h2>
      {trades.length === 0 ? (
        <p className="muted">No trades yet.</p>
      ) : (
        <div className="trade-list">
          {trades.map((t) => (
            <div className="trade-row" key={t.trade_id}>
              <span className="trade-price">{t.price}</span>
              <span className="trade-qty">{t.qty}</span>
              <span className="trade-time">{formatTs(t.ts)}</span>
              <span className="trade-parties muted" title={`bid ${t.bid_trader} / ask ${t.ask_trader}`}>
                {short(t.bid_trader)} / {short(t.ask_trader)}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
