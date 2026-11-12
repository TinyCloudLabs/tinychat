// Supervisor process: the internal API plus the bot sandboxes. Holds BOTS_SERVICE_SECRET and nothing else secret;
// the model key lives only in the gateway container.

import { mkdirSync } from "node:fs";
import { rootProblem } from "./retention";
import { BotManager } from "./bot";
import { supervisorConfig } from "./config";
import { RunscHost } from "./sandbox";
import { createApp } from "./server";

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;

const cfg = supervisorConfig(process.env);
for (const root of [cfg.dataRoot, cfg.runRoot]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (rootProblem(root, process.geteuid!())) throw new Error("untrusted bot root");
}
const host = new RunscHost(cfg);
await host.init();
const bots = new BotManager(
  host,
  cfg,
  { idleMs: cfg.idleMs, turnTimeoutMs: cfg.turnTimeoutMs, maxTurnBytes: cfg.maxTurnBytes },
  cfg.maxRunning,
);

Bun.serve({
  port: cfg.port,
  // Cold starts can take a while before the first byte of a list response.
  idleTimeout: 120,
  maxRequestBodySize: 64 * 1024,
  fetch: createApp({ secret: cfg.serviceSecret, accounts: cfg.accounts, bots }),
});
console.log(
  JSON.stringify({ bots: "listening", port: cfg.port, model: cfg.model, idleMs: cfg.idleMs, retentionDays: cfg.retentionDays, limits: cfg.limits }),
);

// Working state unused for BOTS_RETENTION_DAYS is deleted: checked at startup, then every 6 hours.
const sweep = () => void bots.sweepUnused(cfg.retentionDays * DAY_MS);
sweep();
const sweeps = setInterval(sweep, SWEEP_MS);
sweeps.unref();

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweeps);
    void bots.stopAll().finally(() => process.exit(0));
  });
}
