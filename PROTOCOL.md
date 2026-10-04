# OpenBook protocol specification

This document is the contract between the matching engine, the API, and the
settlement contracts. All components implement exactly what is described here.

## Units and scaling

All money values are integers. No floats anywhere in matching or settlement.

- `qty`: amount of the base token, in the token's smallest units (18 decimals).
  Represented as a decimal string, e.g. `"10000000000000000000"` is 10.0 tokens.
- `price`: quote token per one base token, scaled by 1e8. Represented as a
  decimal string, e.g. `"5000000000000"` is 50000.0 quote per base.
- `quote_amount` for a fill of qty q at price p (both integers):
  `quote_amount = q * p / 1_000_000_00` (integer division, rounds down),
  denominated in the quote token's smallest units (18 decimals).

## Symbols

A symbol is a string like `"BTC/USDC"`: base token symbol, slash, quote token
symbol. The engine keeps one order book per symbol.

## Matching engine stdio protocol

The engine is a single binary. It reads newline-delimited JSON requests from
stdin and writes one newline-delimited JSON response per request to stdout,
in order. Requests are processed strictly sequentially.

### Requests

```jsonc
// Place an order. type is "limit" or "market". Market orders ignore price.
{"cmd": "new_order", "symbol": "BTC/USDC", "order_id": "o1", "trader": "0xabc...",
 "side": "bid", "type": "limit", "price": "5000000000000", "qty": "10000000000000000000"}

// Cancel a resting order.
{"cmd": "cancel", "symbol": "BTC/USDC", "order_id": "o1"}

// Amend price and/or qty of a resting order. Implemented as cancel + replace:
// the amended order gets a fresh timestamp (loses time priority).
{"cmd": "amend", "symbol": "BTC/USDC", "order_id": "o1",
 "price": "5100000000000", "qty": "5000000000000000000"}

// Depth snapshot: bids and asks as [price, qty] string pairs, best first.
{"cmd": "book", "symbol": "BTC/USDC", "depth": 20}

// Recent trades, newest first.
{"cmd": "trades", "symbol": "BTC/USDC", "limit": 50}

// Engine liveness.
{"cmd": "ping"}
```

Sides: `"bid"` (buy base with quote) or `"ask"` (sell base for quote).

### Responses

```jsonc
// Success. "events" lists everything the command caused, in order.
{"ok": true, "events": [
  {"type": "order_accepted", "order_id": "o1", "symbol": "BTC/USDC"},
  {"type": "trade", "trade_id": 7, "symbol": "BTC/USDC",
   "price": "5000000000000", "qty": "3000000000000000000",
   "taker_order": "o2", "maker_order": "o1",
   "taker_trader": "0xdef...", "maker_trader": "0xabc...",
   "bid_trader": "0xdef...", "ask_trader": "0xabc...",
   "ts": 1728000000},
  {"type": "order_cancelled", "order_id": "o3", "symbol": "BTC/USDC",
   "reason": "self_trade"}
]}

// Failure. No state changed.
{"ok": false, "error": "unknown order: o9"}
```

### Matching rules

- Price-time priority: at each price level, orders match in insertion order.
  Bids match against the lowest ask at or below the bid price; asks match
  against the highest bid at or above the ask price.
- Market orders execute immediately against the book; any unfilled remainder
  is cancelled (it never rests).
- Limit orders may rest on the book. Partial fills are allowed.
- Deterministic: given the same input sequence, the engine always produces
  the same trades and book state.
- Self-trade prevention: when an incoming order would match a resting order
  from the same `trader` address, the resting order is cancelled first
  (event `order_cancelled` with reason `"self_trade"`) and matching continues
  against the remaining book.
- `cancel` of an unknown or already-filled order is an error.
- `amend` of an unknown order is an error. Amend keeps the same order_id but
  is treated as a fresh order for priority purposes.

## EIP-712 orders (API and contracts)

Traders sign orders off-chain. The API verifies signatures; the Settlement
contract verifies them again on-chain.

Domain:

```text
name: "OpenBook"
version: "1"
chainId: <configured, e.g. 31337 for local>
verifyingContract: <Settlement contract address>
```

Order struct:

```solidity
struct Order {
    address trader;
    address baseToken;
    address quoteToken;
    uint8   side;    // 0 = bid, 1 = ask
    uint256 price;   // quote per base, scaled 1e8
    uint256 qty;     // base amount, smallest units
    uint256 nonce;   // per-trader nonce, must be unused
    uint256 expiry;  // unix timestamp, order invalid at/after this
}
```

Type string for signing:

```text
Order(address trader,address baseToken,address quoteToken,uint8 side,uint256 price,uint256 qty,uint256 nonce,uint256 expiry)
```

The API converts human-readable decimals to the integer forms above before
verifying: qty = round(qty_decimal * 1e18), price = round(price_decimal * 1e8).
It verifies the recovered signer equals `order.trader`, the nonce is fresh
(per-trader counter kept by the API), and `expiry` is in the future. Orders
failing verification are rejected with HTTP 400.

## REST API

Base: `http://localhost:3001`. All JSON.

```text
POST /api/orders
  body: {symbol, side: "bid"|"ask", type: "limit"|"market",
         price?: "50000.0", qty: "1.5",
         trader: "0x...", sig: "0x...",
         baseToken: "0x...", quoteToken: "0x...",
         nonce: 1, expiry: 1893456000}
  -> 200 {order_id, status: "accepted"|"filled"|"partial", trades: [...]}
  -> 400 {error}

DELETE /api/orders/:order_id?symbol=BTC/USDC -> 200 {cancelled: true} | 404
PATCH  /api/orders/:order_id  body: {symbol, price?, qty?} -> 200 {amended: true}

GET /api/book?symbol=BTC/USDC&depth=20
  -> 200 {symbol, bids: [["50000.0","1.5"],...], asks: [...], ts}
  (prices/qtys rendered back as human decimals)

GET /api/trades?symbol=BTC/USDC&limit=50
  -> 200 {trades: [{trade_id, price, qty, bid_trader, ask_trader, ts}, ...]}

GET /api/health -> 200 {ok: true}

POST /api/settle
  Builds the settlement batch for recent unmatched-on-chain trades and
  submits it to the configured chain. -> 200 {tx_hash, settled: n} | 400/500
```

## WebSocket feed

`ws://localhost:3001/ws`. Client sends:

```json
{"type": "subscribe", "symbol": "BTC/USDC"}
```

Server pushes:

```jsonc
// Full depth snapshot (on subscribe and after every trade batch)
{"type": "snapshot", "symbol": "BTC/USDC",
 "bids": [["50000.0","1.5"]], "asks": [["50100.0","0.8"]], "ts": 1728000000}

// One message per trade, in execution order
{"type": "trade", "symbol": "BTC/USDC", "trade_id": 7,
 "price": "50000.0", "qty": "0.3",
 "bid_trader": "0x...", "ask_trader": "0x...", "ts": 1728000000}
```

## On-chain settlement

- `Vault`: custody for ERC-20 deposits. `deposit(token, amount)`,
  `withdraw(token, amount)`, `balanceOf(user, token)`. Only the Settlement
  contract may move balances between users.
- `Settlement`: EIP-712 `Order` verification (domain above), per-trader
  nonces, expiry checks, and `settle(fills)` where each fill references two
  signed orders and an execution price/qty. Reverts on bad signature, reused
  nonce, expired order, or insufficient vault balance. Balance updates follow
  the quote_amount formula above.
- Test tokens: simple mintable ERC-20s used by tests and the demo.

## Trust model (summary)

- Matching is operator-run: the off-chain engine orders trades. Users do not
  need to trust it with funds, only with fair ordering.
- Custody and settlement are trustless: tokens live in the Vault contract;
  settlement only executes correctly signed, unexpired orders with sufficient
  balances. A malicious operator cannot steal funds, only delay or misorder.
