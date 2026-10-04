# OpenBook architecture

OpenBook is a decentralized exchange with a central limit order book. Matching
happens off-chain in a Rust engine for speed; custody and settlement happen
on-chain in Solidity contracts so funds never depend on trusting the operator.

## Components

```text
apps/web (React) ──REST/WS──> apps/api (Fastify + TypeScript)
                                    │
                        ┌───────────┴───────────┐
                        ▼                       ▼
              crates/matching-engine     contracts/Settlement.sol
              (Rust, stdio JSON)         (EVM, EIP-712)
                        │                       │
                        └───────────┬───────────┘
                                    ▼
                              contracts/Vault.sol
                              (ERC-20 custody)
```

- **Matching engine** (`crates/matching-engine`): a single binary that owns the
  order books. It speaks newline-delimited JSON over stdio (see PROTOCOL.md).
  One book per symbol, price-time priority, integer-only arithmetic.
- **API** (`apps/api`): the only component that talks to the engine. It
  validates EIP-712 signatures, tracks nonces, converts human decimals to
  integer units, and fans trade events out over WebSocket. It also builds
  settlement batches and submits them on-chain.
- **Contracts** (`contracts/`): `Vault` holds ERC-20 deposits; `Settlement`
  verifies signed orders and moves balances. `TestToken` is a mintable ERC-20
  used by tests and the demo.
- **Web UI** (`apps/web`): a trading terminal. It signs orders locally in the
  browser and submits them to the API.

## Order lifecycle

1. The trader signs an EIP-712 `Order` (trader, tokens, side, price, qty,
   nonce, expiry) with their wallet. The private key never leaves their
   machine.
2. The UI (or any client) POSTs the order plus signature to `/api/orders`.
3. The API verifies the signature recovers to `order.trader`, checks the
   nonce is fresh and the order is not expired, converts decimals to integer
   units, and forwards it to the engine.
4. The engine matches deterministically under price-time priority and
   returns trade events. The API broadcasts them over WebSocket and stores
   the signed orders for settlement.
5. Settlement: `POST /api/settle` collects unsettled trades, builds one
   `Fill` per trade (both signed orders plus execution price/qty), and calls
   `Settlement.settle` on-chain. The contract re-verifies everything:
   signatures, nonces, expiries, price limits, and vault balances, then
   updates balances in the Vault.

## Matching rules

- Bids match the lowest ask at or below the bid price; asks match the highest
  bid at or above the ask price. Within a price level, earlier orders fill
  first.
- Trades execute at the resting (maker) order's price.
- Market orders sweep the book and any unfilled remainder is cancelled; they
  never rest.
- Amend is cancel plus replace: the amended order loses time priority.
- Self-trade prevention: if an incoming order would match the same trader's
  resting order, the resting order is cancelled first and matching continues.
- All timestamps in engine events are logical sequence numbers, so replaying
  the same input sequence always produces the same output.

## Units

Money is integers everywhere. `qty` is base-token smallest units (18
decimals). `price` is quote per base scaled by 1e8. A fill of qty `q` at
price `p` moves `q * p / 1e8` quote-token smallest units (integer division,
rounds down). See PROTOCOL.md for the full specification.

## Trust model

What is trustless:

- Custody. Tokens sit in the Vault contract. Only a valid `settle` call can
  move them, and `settle` reverts unless both orders are correctly signed,
  unexpired, unused, and funded.
- Settlement correctness. The contract, not the operator, decides whether a
  fill is valid. A malicious operator cannot steal funds or forge trades.

What is operator-trusted:

- Ordering fairness. The off-chain engine decides match order. It cannot
  steal, but a dishonest operator could reorder, delay, or censor orders.
  (A production system would commit to an ordering, e.g. signed sequence
  numbers or a fair-ordering protocol; that is out of scope here.)
- Liveness. If the API or engine goes down, trading stops until it restarts.
  Funds remain withdrawable from the Vault at any time.

## What the demo proves

`demo.sh` runs the full loop on a local Hardhat chain: token minting,
deposits, signed order placement, off-chain matching, on-chain batch
settlement, and balance verification before and after. It exercises the real
contracts, the real engine, and the real API.
