// Supervisor process: the internal API plus the bot sandboxes. Holds BOTS_SERVICE_SECRET and nothing else secret;
// the model key lives only in the gateway container.

import { BotManager } from "./bot";
import { supervisorConfig } from "./config";
import { RunscHost } from "./sandbox";
import { createApp } from "./server";

const cfg = supervisorConfig(process.env);
const host = new RunscHost(cfg);
await host.init();
const bots = new BotManager(host, cfg, cfg.idleMs);

Bun.serve({
  port: cfg.port,
  // Cold starts can take a while before the first byte of a list response.
  idleTimeout: 120,
  maxRequestBodySize: 64 * 1024,
  fetch: createApp({ secret: cfg.serviceSecret, accounts: cfg.accounts, bots }),
});
console.log(JSON.stringify({ bots: "listening", port: cfg.port, model: cfg.model, idleMs: cfg.idleMs, limits: cfg.limits }));

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void bots.stopAll().finally(() => process.exit(0));
  });
}
