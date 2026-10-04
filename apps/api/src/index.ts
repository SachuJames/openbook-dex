import { buildServer } from "./server.js";
import { config } from "./config.js";

const { app, close } = await buildServer();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`received ${signal}, shutting down`);
  try {
    await close();
  } catch (err) {
    console.error("error during shutdown", err);
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`OpenBook API listening on http://${config.host}:${config.port}`);
} catch (err) {
  console.error("failed to start server", err);
  await close();
  process.exit(1);
}
