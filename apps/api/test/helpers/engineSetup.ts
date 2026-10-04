import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../../src/config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");

let buildPromise: Promise<string> | null = null;

function findBinary(): string | null {
  const candidates = [
    process.env.ENGINE_BIN ?? config.engineBin,
    path.join(repoRoot, "crates", "matching-engine", "target", "release", "openbook-engine"),
  ];
  for (const bin of candidates) {
    if (bin && fs.existsSync(bin)) return bin;
  }
  return null;
}

/**
 * Ensure the real matching-engine binary exists, building it with
 * `cargo build --release` inside the crate directory when needed.
 * Returns the binary path.
 */
export function ensureEngineBinary(): Promise<string> {
  if (!buildPromise) {
    buildPromise = (async () => {
      const existing = findBinary();
      if (existing) return existing;
      const crateDir = path.join(repoRoot, "crates", "matching-engine");
      if (!fs.existsSync(path.join(crateDir, "Cargo.toml"))) {
        throw new Error(
          `engine source not found at ${crateDir}; cannot build the engine binary`,
        );
      }
      const env = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };
      execFileSync("cargo", ["build", "--release"], {
        cwd: crateDir,
        env,
        stdio: "pipe",
        timeout: 600000,
      });
      const built = findBinary();
      if (!built) {
        throw new Error("cargo build succeeded but no engine binary was produced");
      }
      return built;
    })();
  }
  return buildPromise;
}
