// Supervisor process: the internal API plus the bot sandboxes. Holds the secrets for signed bots calls.
// The model key lives only in the gateway container.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { rootProblem } from "./retention";
import { BotManager } from "./bot";
import { createAdmissionClient } from "./bot-admission";
import { supervisorConfig } from "./config";
import { OwnerManifests } from "./manifest";
import { RunscHost } from "./sandbox";
import { createApp } from "./server";

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;

const cfg = supervisorConfig(process.env);
// Which siblings the backend has announced, per owner. On the data volume, beside the bots' own directories (which
// are named by 64 hex characters, so the sweep never takes this one for a bot) and never mounted into a sandbox.
const manifestRoot = join(cfg.dataRoot, "owners");
for (const root of [cfg.dataRoot, cfg.runRoot, manifestRoot]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (rootProblem(root, process.geteuid!())) throw new Error("untrusted bot root");
}
const host = new RunscHost(cfg);
await host.init();
const bots = new BotManager(
  host,
  cfg,
  { idleMs: cfg.idleMs, turnTimeoutMs: cfg.turnTimeoutMs, maxTurnBytes: cfg.maxTurnBytes, history: cfg.history },
  cfg.maxRunning,
);

Bun.serve({
  port: cfg.port,
  // Cold starts can take a while before the first byte of a list response.
  idleTimeout: 120,
  maxRequestBodySize: 1024 * 1024,
  fetch: createApp({
    secret: cfg.serviceSecret, accounts: cfg.accounts, environment: "private", acceptLegacyOwnerHeader: cfg.acceptLegacyOwnerHeader,
    bots, manifest: new OwnerManifests(manifestRoot, cfg.maxBotsPerOwner),
    admit: cfg.admissionControlKey ? createAdmissionClient(cfg.egressRoot, cfg.admissionControlKey) : undefined,
  }),
});
console.log(
  JSON.stringify({ bots: "listening", port: cfg.port, model: cfg.model, idleMs: cfg.idleMs, retentionDays: cfg.retentionDays, limits: cfg.limits, acceptLegacyOwnerHeader: cfg.acceptLegacyOwnerHeader }),
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
