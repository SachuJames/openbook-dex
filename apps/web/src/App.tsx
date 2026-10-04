import { useState } from "react";
import { SYMBOL } from "./config";
import { useFeed } from "./useFeed";
import { OrderBook } from "./components/OrderBook";
import { RecentTrades } from "./components/RecentTrades";
import { OrderForm } from "./components/OrderForm";
import "./index.css";

const CONN_LABEL = {
  connecting: "connecting",
  live: "live",
  closed: "reconnecting",
} as const;

function App() {
  const { conn, snapshot, trades } = useFeed();
  // Single market for now. SYMBOL is the constant to change to repoint the UI.
  const [symbol] = useState(SYMBOL);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">OB</span>
          <span className="brand-name">OpenBook</span>
        </div>
        <label className="symbol-select">
          Market
          <select value={symbol} disabled>
            <option value={symbol}>{symbol}</option>
          </select>
        </label>
        <div className="status">
          <span className={`dot ${conn}`} />
          <span>{CONN_LABEL[conn]}</span>
        </div>
      </header>

      <main className="layout">
        <OrderBook snapshot={snapshot} />
        <OrderForm />
        <RecentTrades trades={trades} />
      </main>

      <footer className="footnote">
        <span>API {SYMBOL} feed on ws://localhost:3001/ws</span>
        <span>Private keys are signed locally and never stored or sent to the server.</span>
      </footer>
    </div>
  );
}

export default App;
