import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
    path.resolve(here, "..", "..", "target", "release", "openbook-engine"),
  settlementArtifact: path.resolve(
    here,
    "..",
    "..",
    "contracts",
    "artifacts",
    "contracts",
    "Settlement.sol",
    "Settlement.json",
  ),
};
