import { useState } from "react";
import { ethers } from "ethers";
import {
  API_BASE,
  BASE_TOKEN_ADDRESS,
  CHAIN_ID,
  EIP712_DOMAIN,
  EIP712_TYPES,
  PRICE_DECIMALS,
  QTY_DECIMALS,
  QUOTE_TOKEN_ADDRESS,
  SIDE_ASK,
  SIDE_BID,
  SYMBOL,
  decimalToUnits,
} from "../config";
import type { OrderResult } from "../types";

type Side = "bid" | "ask";
type OrderType = "limit" | "market";

/** Generate a random per-order nonce so it cannot collide with past orders. */
function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return BigInt(
    "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""),
  ).toString();
}

export function OrderForm() {
  const [side, setSide] = useState<Side>("bid");
  const [orderType, setOrderType] = useState<OrderType>("limit");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("");
  const [trader, setTrader] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OrderResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [cancelId, setCancelId] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);

  const onPrivateKey = (value: string) => {
    setPrivateKey(value);
    // Convenience: derive the trader address from the key so the signer
    // matches. The field stays editable in case the key controls a different
    // account, but a mismatch will be rejected by the API.
    try {
      setTrader(new ethers.Wallet(value.trim()).address);
    } catch {
      // not a valid key yet, leave trader untouched
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResult(null);

    try {
      if (!privateKey.trim()) throw new Error("private key is required to sign");
      if (!ethers.isAddress(trader.trim())) throw new Error("invalid trader address");
      const qtyUnits = decimalToUnits(qty, QTY_DECIMALS); // qty * 1e18
      if (qtyUnits === "0") throw new Error("qty must be greater than 0");

      let priceHuman: string | undefined;
      let priceUnits = "0";
      if (orderType === "limit") {
        priceUnits = decimalToUnits(price, PRICE_DECIMALS); // price * 1e8
        if (priceUnits === "0") throw new Error("price must be greater than 0");
        priceHuman = price.trim();
      }

      const wallet = new ethers.Wallet(privateKey.trim());
      const nonce = randomNonce();
      const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour

      // Signed integers go into the EIP-712 payload; the REST body carries
      // the human decimals, which the API converts and verifies before
      // accepting.
      const order = {
        trader: ethers.getAddress(trader.trim()),
        baseToken: BASE_TOKEN_ADDRESS,
        quoteToken: QUOTE_TOKEN_ADDRESS,
        side: side === "bid" ? SIDE_BID : SIDE_ASK,
        price: priceUnits,
        qty: qtyUnits,
        nonce,
        expiry,
      };
      const sig = await wallet.signTypedData(
        { ...EIP712_DOMAIN, chainId: CHAIN_ID },
        EIP712_TYPES,
        order,
      );

      setBusy(true);
      const body = {
        symbol: SYMBOL,
        side,
        type: orderType,
        price: priceHuman,
        qty: qty.trim(),
        trader: order.trader,
        sig,
        baseToken: order.baseToken,
        quoteToken: order.quoteToken,
        nonce,
        expiry,
      };
      const res = await fetch(`${API_BASE}/api/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `request failed with status ${res.status}`);
      }
      setResult(data as OrderResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setCancelMsg(null);
    if (!cancelId.trim()) {
      setCancelMsg("enter an order id to cancel");
      return;
    }
    setCancelBusy(true);
    try {
      const res = await fetch(
        `${API_BASE}/api/orders/${encodeURIComponent(cancelId.trim())}?symbol=${encodeURIComponent(SYMBOL)}`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error ?? `request failed with status ${res.status}`);
      }
      setCancelMsg(`order ${cancelId.trim()} cancelled`);
    } catch (err) {
      setCancelMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelBusy(false);
    }
  };

  const isBuy = side === "bid";

  return (
    <section className="panel order-form">
      <h2>Place Order</h2>
      <form onSubmit={submit}>
        <div className="toggle">
          <button
            type="button"
            className={isBuy ? "active buy" : ""}
            onClick={() => setSide("bid")}
          >
            Buy
          </button>
          <button
            type="button"
            className={!isBuy ? "active sell" : ""}
            onClick={() => setSide("ask")}
          >
            Sell
          </button>
        </div>
        <div className="toggle">
          <button
            type="button"
            className={orderType === "limit" ? "active" : ""}
            onClick={() => setOrderType("limit")}
          >
            Limit
          </button>
          <button
            type="button"
            className={orderType === "market" ? "active" : ""}
            onClick={() => setOrderType("market")}
          >
            Market
          </button>
        </div>

        <label>
          Price (quote per base)
          <input
            type="text"
            inputMode="decimal"
            placeholder="50000.0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={orderType === "market"}
            required={orderType === "limit"}
          />
        </label>
        <label>
          Qty (base)
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.5"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            required
          />
        </label>
        <label>
          Trader address
          <input
            type="text"
            placeholder="0x..."
            value={trader}
            onChange={(e) => setTrader(e.target.value)}
            required
          />
        </label>
        <label>
          Private key <span className="demo-only">demo only, never stored</span>
          <input
            type="password"
            placeholder="0x... (used only to sign locally)"
            value={privateKey}
            onChange={(e) => onPrivateKey(e.target.value)}
            required
          />
        </label>

        <button type="submit" className={`submit ${isBuy ? "buy" : "sell"}`} disabled={busy}>
          {busy ? "Submitting..." : isBuy ? "Buy" : "Sell"} {SYMBOL}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {result && (
        <div className="result">
          <p>
            Order <code>{result.order_id}</code>: <strong>{result.status}</strong>
          </p>
          {result.trades.length > 0 && (
            <ul>
              {result.trades.map((t) => (
                <li key={t.trade_id}>
                  trade {t.trade_id}: {t.qty} @ {t.price}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="cancel-box">
        <h3>Cancel Order</h3>
        <div className="cancel-row">
          <input
            type="text"
            placeholder="order id"
            value={cancelId}
            onChange={(e) => setCancelId(e.target.value)}
          />
          <button type="button" onClick={cancel} disabled={cancelBusy}>
            {cancelBusy ? "Cancelling..." : "Cancel"}
          </button>
        </div>
        {cancelMsg && <p className="muted">{cancelMsg}</p>}
      </div>
    </section>
  );
}
