import path from "node:path";

// Resolve paths from the repo root. The server is run with the working
// directory set to apps/api (npm run start, npm run dev, vitest), so the
// repo root is two levels up. Both paths can be overridden via env.
const repoRoot = path.resolve(process.cwd(), "..", "..");

export const config = {
  host: process.env.API_HOST ?? "127.0.0.1",
  port: Number(process.env.API_PORT ?? "3001"),
  chainId: Number(process.env.CHAIN_ID ?? "31337"),
  settlementAddress:
    process.env.SETTLEMENT_ADDRESS ??
    "0x0000000000000000000000000000000000000000",
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  settlerKey: process.env.SETTLER_KEY,
  engineBin:
    process.env.ENGINE_BIN ??
    path.join(repoRoot, "target", "release", "openbook-engine"),
  settlementArtifact:
    process.env.SETTLEMENT_ARTIFACT ??
    path.join(
      repoRoot,
      "contracts",
      "artifacts",
      "contracts",
      "Settlement.sol",
      "Settlement.json",
    ),
};
