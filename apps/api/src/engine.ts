import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.js";

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineEvent {
  type: string;
  [key: string]: unknown;
}

export interface EngineResponse {
  ok: boolean;
  events?: EngineEvent[];
  error?: string;
  [key: string]: unknown;
}

export interface NewOrderRequest {
  cmd: "new_order";
  symbol: string;
  order_id: string;
  trader: string;
  side: "bid" | "ask";
  type: "limit" | "market";
  price: string;
  qty: string;
}

export interface CancelRequest {
  cmd: "cancel";
  symbol: string;
  order_id: string;
}

export interface AmendRequest {
  cmd: "amend";
  symbol: string;
  order_id: string;
  price?: string;
  qty?: string;
}

const REQUEST_TIMEOUT_MS = 15000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Client for the matching engine child process. The engine speaks
 * newline-delimited JSON over stdio and processes requests strictly
 * sequentially, so this client keeps exactly one request in flight at a
 * time via an internal promise queue.
 */
export class EngineClient {
  private child: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lineResolvers: Array<(line: string) => void> = [];
  private buffer = "";
  private stderrTail = "";
  private dead = false;
  private bin: string;

  constructor(bin?: string) {
    this.bin = bin ?? process.env.ENGINE_BIN ?? config.engineBin;
  }

  start(): void {
    if (this.child) return;
    this.dead = false;
    const child = spawn(this.bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    child.on("error", (err) => this.onDeath(`spawn failed: ${err.message}`));
    child.on("exit", (code, signal) =>
      this.onDeath(`exited with code ${code} signal ${signal}`),
    );
    if (!child.stdin || !child.stdout) {
      this.onDeath("stdio pipes unavailable");
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length === 0) continue;
      const resolve = this.lineResolvers.shift();
      if (resolve) resolve(line);
    }
  }

  private onDeath(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    const err = new EngineError(`engine process died: ${reason}`);
    for (const resolve of this.lineResolvers.splice(0)) {
      // Resolve with a sentinel the pending request turns into a throw.
      resolve(JSON.stringify({ ok: false, __dead: true, error: err.message }));
    }
    this.child = null;
  }

  private readLine(): Promise<string> {
    return new Promise((resolve) => {
      this.lineResolvers.push(resolve);
    });
  }

  private async sendRaw(request: Record<string, unknown>): Promise<EngineResponse> {
    const run = async (): Promise<EngineResponse> => {
      if (this.dead || !this.child?.stdin) {
        throw new EngineError("engine process is not running");
      }
      const payload = JSON.stringify(request) + "\n";
      const linePromise = this.readLine();
      const timeout = new Promise<never>((_, reject) => {
        const t = setTimeout(() => {
          reject(new EngineError("engine request timed out"));
        }, REQUEST_TIMEOUT_MS);
        linePromise.then(
          () => clearTimeout(t),
          () => clearTimeout(t),
        );
      });
      this.child.stdin.write(payload);
      const line = await Promise.race([linePromise, timeout]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new EngineError(`engine returned invalid JSON: ${line.slice(0, 200)}`);
      }
      if (!isRecord(parsed)) {
        throw new EngineError("engine returned a non-object response");
      }
      const response = parsed as EngineResponse;
      if (response.ok === false) {
        throw new EngineError(
          typeof response.error === "string" ? response.error : "engine error",
        );
      }
      return response;
    };
    // Chain onto the queue so only one request is in flight. A rejection
    // must not break the chain for later requests.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result as Promise<EngineResponse>;
  }

  async ping(): Promise<boolean> {
    const res = await this.sendRaw({ cmd: "ping" });
    return res.ok === true;
  }

  async newOrder(req: Omit<NewOrderRequest, "cmd">): Promise<EngineResponse> {
    return this.sendRaw({ cmd: "new_order", ...req });
  }

  async cancel(req: Omit<CancelRequest, "cmd">): Promise<EngineResponse> {
    return this.sendRaw({ cmd: "cancel", ...req });
  }

  async amend(req: Omit<AmendRequest, "cmd">): Promise<EngineResponse> {
    return this.sendRaw({ cmd: "amend", ...req });
  }

  async book(symbol: string, depth = 20): Promise<EngineResponse> {
    return this.sendRaw({ cmd: "book", symbol, depth });
  }

  async trades(symbol: string, limit = 50): Promise<EngineResponse> {
    return this.sendRaw({ cmd: "trades", symbol, limit });
  }

  get running(): boolean {
    return !this.dead && this.child !== null;
  }

  /** Terminate the engine child process. Resolves when it has exited. */
  async kill(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        // If the exit event never arrives, resolve anyway after SIGKILL.
        setTimeout(done, 1000);
      }, 2000);
    });
    this.child = null;
    this.dead = true;
  }
}
