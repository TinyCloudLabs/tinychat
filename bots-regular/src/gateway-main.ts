// The regular runtime's model gateway, run as its own container: TCP on BOTS_REGULAR_GATEWAY_PORT at
// /bots/<botId>/v1/..., and the control API on BOTS_REGULAR_GATEWAY_CONTROL_SOCKET.

import { chmodSync, rmSync } from "node:fs";
import { BotAci } from "../../bots/src/aci";
import { gatewayConfig } from "../../bots/src/config";
import { fileBudgetStore, fileOwnerStore, Gateway } from "../../bots/src/gateway";
import { controlFetch, sandboxFetch } from "./gateway-front";

const cfg = gatewayConfig(process.env);
const port = Number(process.env.BOTS_REGULAR_GATEWAY_PORT ?? 8081);
const controlSocket = process.env.BOTS_REGULAR_GATEWAY_CONTROL_SOCKET ?? "/run/gateway/control.sock";
const aci = process.env.BOTS_HISTORY_ENABLED === "true" ? new BotAci(cfg.upstream) : undefined;

let gateway: Gateway;
try {
  gateway = new Gateway(cfg, {
    store: fileBudgetStore(cfg.budgetFile),
    ownerStore: cfg.ownersFile ? fileOwnerStore(cfg.ownersFile) : undefined,
    verifiedFetch: aci ? (botId, url, init) => aci.fetch(botId, url, init) : undefined,
  });
} catch (error) {
  console.error(JSON.stringify({
    gateway: "refusing_to_start",
    reason: error instanceof Error ? error.message : "unknown",
    fix: "budget counters cannot be restored; see 'Budget file recovery' in bots/README.md",
  }));
  process.exit(78);
}

const toSandbox = sandboxFetch(gateway);
const sandboxes = Bun.serve({
  port,
  maxRequestBodySize: cfg.maxBodyBytes,
  // As in the private gateway: Bun's idle timeout bounds slow headers and bodies until a call is accepted.
  fetch: (req, server) => toSandbox(req, () => server.timeout(req, 0)),
});

// Registrations do not survive a restart; the service registers again before every message.
rmSync(controlSocket, { force: true });
const control = Bun.serve({ unix: controlSocket, fetch: controlFetch(gateway, botId => aci?.take(botId) ?? []) });
// The service container runs as another user.
chmodSync(controlSocket, 0o666);

console.log(JSON.stringify({ gateway: "listening", runtime: "regular", port: sandboxes.port, models: cfg.models }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void sandboxes.stop(true);
    void control.stop(true);
    process.exit(0);
  });
}
