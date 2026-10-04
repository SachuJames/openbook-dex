#!/usr/bin/env bash
# End-to-end OpenBook demo on a local Hardhat chain:
# build engine, start chain, deploy contracts, fund traders, run the API,
# place signed orders, match a trade off-chain, settle it on-chain,
# and verify vault balances. Exits 0 only if every step succeeds.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$HOME/.cargo/bin:$PATH"

HARDHAT_PID=""
API_PID=""

# Demo keys are read from the local Hardhat node's log at runtime
# (Hardhat prints its public local test keys on startup; local demo only).
MAKER_KEY=""
TAKER_KEY=""
export MAKER_KEY TAKER_KEY
export RPC_URL="http://127.0.0.1:8545"
export API_BASE="http://127.0.0.1:3001"

cleanup() {
  [ -n "$HARDHAT_PID" ] && kill "$HARDHAT_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "== building matching engine =="
(cd "$ROOT" && cargo build --release -p openbook-engine)

echo "== installing dependencies =="
[ -d "$ROOT/contracts/node_modules" ] || (cd "$ROOT/contracts" && npm install --no-audit --no-fund)
[ -d "$ROOT/apps/api/node_modules" ] || (cd "$ROOT/apps/api" && npm install --no-audit --no-fund)
(cd "$ROOT/apps/api" && npm run build)

echo "== starting local chain =="
cd "$ROOT/contracts"
node "$ROOT/contracts/node_modules/hardhat/internal/cli/cli.js" node > "$ROOT/hardhat-node.log" 2>&1 &
HARDHAT_PID=$!
cd "$ROOT"
for _ in $(seq 1 30); do
  if curl -sf -X POST -H "content-type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "$RPC_URL" > /dev/null; then
    break
  fi
  sleep 1
done
curl -sf -X POST -H "content-type: application/json" \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "$RPC_URL" > /dev/null || { echo "local chain did not start"; exit 1; }

# Read the node's public local test keys from its startup log.
MAKER_KEY=$(grep -A1 "Account #0:" "$ROOT/hardhat-node.log" | grep "Private Key" | awk '{print $3}')
TAKER_KEY=$(grep -A1 "Account #1:" "$ROOT/hardhat-node.log" | grep "Private Key" | awk '{print $3}')
export MAKER_KEY TAKER_KEY
[ -n "$MAKER_KEY" ] && [ -n "$TAKER_KEY" ] || { echo "could not read test keys"; exit 1; }

echo "== deploying contracts =="
(cd "$ROOT/contracts" && npx hardhat run scripts/deploy.js --network localhost 2>/dev/null \
  | grep -o '{.*}' | tail -1 > "$ROOT/deploy.json")
export VAULT_ADDRESS;      VAULT_ADDRESS=$(node -p "require('$ROOT/deploy.json').vault")
export SETTLEMENT_ADDRESS; SETTLEMENT_ADDRESS=$(node -p "require('$ROOT/deploy.json').settlement")
export BASE_TOKEN;         BASE_TOKEN=$(node -p "require('$ROOT/deploy.json').baseToken")
export QUOTE_TOKEN;        QUOTE_TOKEN=$(node -p "require('$ROOT/deploy.json').quoteToken")
echo "vault:      $VAULT_ADDRESS"
echo "settlement: $SETTLEMENT_ADDRESS"

echo "== funding traders =="
NODE_PATH="$ROOT/apps/api/node_modules" node "$ROOT/demo/setup.cjs"

echo "== starting API =="
cd "$ROOT/apps/api"
RPC_URL="$RPC_URL" \
  CHAIN_ID="31337" \
  SETTLEMENT_ADDRESS="$SETTLEMENT_ADDRESS" \
  SETTLER_KEY="$MAKER_KEY" \
  ENGINE_BIN="$ROOT/target/release/openbook-engine" \
  node dist/src/index.js > "$ROOT/api.log" 2>&1 &
API_PID=$!
cd "$ROOT"
for _ in $(seq 1 30); do
  if curl -sf "$API_BASE/api/health" > /dev/null; then
    break
  fi
  sleep 1
done
curl -sf "$API_BASE/api/health" > /dev/null || { echo "API did not start (see api.log)"; exit 1; }

echo "== placing orders, matching, settling =="
NODE_PATH="$ROOT/apps/api/node_modules" node "$ROOT/demo/trade.cjs"

echo ""
echo "== demo complete: trade matched off-chain and settled on-chain =="
