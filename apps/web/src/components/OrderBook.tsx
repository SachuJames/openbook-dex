import { BOOK_ROWS } from "../config";
import type { Level, SnapshotMsg } from "../types";

function BookSide({ levels, kind }: { levels: Level[]; kind: "bid" | "ask" }) {
  const rows = levels.slice(0, BOOK_ROWS);
  const maxQty = Math.max(0, ...rows.map(([, qty]) => parseFloat(qty) || 0));

  // Asks render top-down so the best ask sits closest to the spread.
  const ordered = kind === "ask" ? [...rows].reverse() : rows;

  return (
    <div className={`book-side ${kind}`}>
      {ordered.map(([price, qty]) => {
        const width = maxQty > 0 ? (parseFloat(qty) / maxQty) * 100 : 0;
        return (
          <div className="book-row" key={`${price}-${qty}`}>
            <span className="bar" style={{ width: `${width}%` }} />
            <span className="price">{price}</span>
            <span className="qty">{qty}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders the depth snapshot pushed by the server ("snapshot" message with
 * bids and asks as [price, qty] human-decimal pairs, best first). Updates
 * whenever a new snapshot arrives. Price, qty, and a depth bar per level.
 */
export function OrderBook({ snapshot }: { snapshot: SnapshotMsg | null }) {
  if (!snapshot) {
    return (
      <section className="panel orderbook">
        <h2>Order Book</h2>
        <p className="muted">Waiting for book snapshot...</p>
      </section>
    );
  }

  const bestBid = snapshot.bids[0]?.[0];
  const bestAsk = snapshot.asks[0]?.[0];
  const spread =
    bestBid && bestAsk ? (parseFloat(bestAsk) - parseFloat(bestBid)).toFixed(4) : "-";

  return (
    <section className="panel orderbook">
      <h2>Order Book</h2>
      <div className="book-header">
        <span>Price</span>
        <span>Qty</span>
      </div>
      <BookSide levels={snapshot.asks} kind="ask" />
      <div className="spread">
        Spread <span>{spread}</span>
      </div>
      <BookSide levels={snapshot.bids} kind="bid" />
    </section>
  );
}
