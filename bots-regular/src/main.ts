// The regular runtime service: the internal API, manifests, bot states and history journal from bots/, with each bot
// in a sandbox on a sandbox host.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BotManager } from "../../bots/src/bot";
import { OwnerManifests } from "../../bots/src/manifest";
import { rootProblem } from "../../bots/src/retention";
import { regularApp } from "./app";
import { regularConfig } from "./config";
import { socketGatewayControl } from "./gateway-front";
import { ARM_COMMAND, GkeProvider, inClusterToken } from "./gke-provider";
import { RegularLauncher } from "./launcher";
import { LocalProvider } from "./local-provider";
import type { SandboxProvider } from "./provider";

const DAY_MS = 24 * 60 * 60_000;
const SWEEP_MS = 6 * 60 * 60_000;

const cfg = regularConfig(process.env);
const manifestRoot = join(cfg.dataRoot, "owners");
for (const root of [cfg.dataRoot, cfg.runRoot, manifestRoot]) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (rootProblem(root, process.geteuid!())) throw new Error("untrusted bot root");
}

let provider: SandboxProvider;
let armCommand = ARM_COMMAND;
if (cfg.provider.kind === "gke") {
  provider = new GkeProvider({ ...cfg.provider, token: inClusterToken });
} else {
  console.warn(JSON.stringify({ bots: "local_provider", warning: "bots run as local processes; for tests and the local check only" }));
  provider = new LocalProvider(cfg.provider.root, cfg.provider.agent, event => console.log(JSON.stringify({ bots: "sandbox", ...event })));
  armCommand = `bun ${join(import.meta.dir, "..", "sandbox", "arm.ts")}`;
}

const launcher = new RegularLauncher(provider, socketGatewayControl(cfg.gatewayControlSocket), {
  model: cfg.model,
  gatewayOrigin: cfg.gatewayOrigin,
  armCommand,
  touchMs: cfg.touchMs,
  startTimeoutMs: cfg.startTimeoutMs,
});
const bots = new BotManager(
  launcher,
  // Nothing of a regular bot is kept under runRoot or egressRoot; BotManager's layout names them all the same.
  { dataRoot: cfg.dataRoot, runRoot: cfg.runRoot, egressRoot: join(cfg.runRoot, "egress") },
  { idleMs: cfg.idleMs, turnTimeoutMs: cfg.turnTimeoutMs, maxTurnBytes: cfg.maxTurnBytes, history: cfg.history },
  cfg.maxRunning,
);

Bun.serve({
  port: cfg.port,
  // Waking a sandbox can take a while before the first byte of a list response.
  idleTimeout: 240,
  maxRequestBodySize: 1024 * 1024,
  fetch: regularApp({ secret: cfg.serviceSecret, accounts: cfg.accounts, bots, manifest: new OwnerManifests(manifestRoot) }),
});
console.log(JSON.stringify({ bots: "listening", runtime: "regular", provider: cfg.provider.kind, port: cfg.port, model: cfg.model, idleMs: cfg.idleMs }));

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
    void bots.stopAll().finally(async () => {
      if (provider instanceof LocalProvider) await provider.close();
      process.exit(0);
    });
  });
}
