// Gateway process. Owns the shared egress volume: one directory per bot holding only that bot's socket, plus a
// control socket at the volume root that only the supervisor can reach (bots see their own directory alone).
//   PUT    /bots/<botId>  {"token": "<64 hex>"}  listen on the bot's socket and accept that token
//   DELETE /bots/<botId>                         stop listening and remove the directory

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { gatewayConfig } from "./config";
import { Gateway } from "./gateway";
import { isRecord } from "./guards";
import { egressPaths } from "./layout";
import { BOT_ID } from "./owner";

const cfg = gatewayConfig(process.env);
const gateway = new Gateway(cfg);
const listeners = new Map<string, Server<undefined>>();

// Registrations do not survive a restart; the supervisor registers again before every message. Stale sockets go,
// but each bot's directory stays: a running sandbox has it bind-mounted and will see the new socket appear in it.
rmSync(join(cfg.egressRoot, "control.sock"), { force: true });
for (const entry of readdirSync(cfg.egressRoot)) {
  if (BOT_ID.test(entry)) rmSync(egressPaths(cfg.egressRoot, entry).socketPath, { force: true });
}

function listen(botId: string): void {
  if (listeners.has(botId)) return;
  const { egressDir, socketPath } = egressPaths(cfg.egressRoot, botId);
  mkdirSync(egressDir, { recursive: true, mode: 0o755 });
  rmSync(socketPath, { force: true });
  const server = Bun.serve({
    unix: socketPath,
    maxRequestBodySize: cfg.maxBodyBytes,
    fetch(req, server) {
      // Streams can sit quiet while the model thinks; the upstream total deadline bounds them instead.
      server.timeout(req, 0);
      return gateway.handle(botId, req);
    },
  });
  // The sandbox's file proxy connects as root; the directory, not the socket mode, keeps other bots out.
  chmodSync(socketPath, 0o666);
  listeners.set(botId, server);
}

function unlisten(botId: string): void {
  void listeners.get(botId)?.stop(true);
  listeners.delete(botId);
  gateway.dropToken(botId);
  rmSync(egressPaths(cfg.egressRoot, botId).egressDir, { recursive: true, force: true });
}

const control = Bun.serve({
  unix: join(cfg.egressRoot, "control.sock"),
  async fetch(req) {
    const match = /^\/bots\/([0-9a-f]{64})$/.exec(new URL(req.url).pathname);
    if (!match) return new Response(null, { status: 404 });
    const botId = match[1]!;
    if (req.method === "DELETE") {
      unlisten(botId);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "PUT") return new Response(null, { status: 405 });
    const body: unknown = await req.json().catch(() => null);
    if (!isRecord(body) || typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token)) {
      return new Response(null, { status: 400 });
    }
    listen(botId);
    gateway.setToken(botId, body.token);
    return new Response(null, { status: 204 });
  },
});

console.log(JSON.stringify({ gateway: "listening", models: cfg.models }));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const botId of [...listeners.keys()]) unlisten(botId);
    void control.stop(true);
    process.exit(0);
  });
}
