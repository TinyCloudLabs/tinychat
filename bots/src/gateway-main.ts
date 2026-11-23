// Gateway process. Owns the shared egress volume: one directory per bot holding only that bot's socket, plus a
// control socket at the volume root that only the supervisor can reach (bots see their own directory alone).
//   PUT    /bots/<botId>  {"token": "<64 hex>", "owner": "<64 hex>"}  listen on the bot's socket and accept that
//                         token; `owner` is the id of its owner's Main (left out, the bot is its own owner)
//   DELETE /bots/<botId>                         stop listening and remove the directory
//   PUT    /bots/<botId>/web  {"mode", "hosts"}  the owner's web-access setting (applies from the bot's next call)
//   GET    /bots/<botId>/web                     {"available", "today": {"searches", "pages", "blocked"}}
//   POST   /bots/<botId>/web/addresses {"urls"}  page addresses the owner typed, which the bot may then read
//   PUT    /bots/<botId>/asks  {"enabled", "pending", "day", "today", "declined", "turn"?}  the owner's setting for questions and the
//                         supervisor's counts (applies from the bot's next call)
//   POST   /bots/<botId>/asks/drain              {"asks", "outside"}: the questions the bot has asked since the last drain, and
//                         whether outside text has reached its conversation (a web call)
//   PUT|DELETE /bots/<botId>/secrets/<id>, POST /bots/<botId>/secrets/drain   secret requests (secret-routes.ts)

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { BotAci } from "./aci";
import { ADMISSION_CONTROL_PATH, createAdmissionRelay, MAX_ADMISSION_BYTES } from "./bot-admission";
import { gatewayConfig, SECRET_ORIGINS } from "./config";
import { sealKeyFromDstack } from "./dstack-key";
import { networkDeps } from "./fetch-net";
import { fileBudgetStore, fileOwnerStore, Gateway } from "./gateway";
import { isRecord } from "./guards";
import { egressPaths } from "./layout";
import { BOT_ID } from "./owner";
import { SecretGrants } from "./secret-grants";
import { nodeSecretReader } from "./secret-node";
import { secretRoute, SECRETS_ROUTE } from "./secret-routes";
import { sealedGrantStore } from "./secret-store";
import { addressKey, readableAddress } from "./web";
import { parseWebPolicy } from "./web-policy";
import { parseAsksPush } from "./asks";

const { backendOrigin, backendCallSecret, ...cfg } = gatewayConfig(process.env);
const admit = createAdmissionRelay(backendOrigin, backendCallSecret);
const aci = process.env.BOTS_HISTORY_ENABLED === "true" ? new BotAci(cfg.upstream) : undefined;

/** How often open secret requests are checked with OpenKey; it keeps an approval for 10 minutes. */
const SECRET_POLL_MS = 5_000;
// Secret requests need the sealing key from the CVM's key service. Without it they are refused (503) and the secret
// tools are not offered, never kept unsealed; everything else runs as before.
async function startSecrets(): Promise<SecretGrants | undefined> {
  try {
    const key = await sealKeyFromDstack();
    const grants = new SecretGrants({ store: sealedGrantStore(cfg.secretGrantsDir!, key), reader: nodeSecretReader(SECRET_ORIGINS.node, undefined, cfg.renewal && { pin: cfg.renewal }), origins: SECRET_ORIGINS, renewal: cfg.renewal });
    // The deploy check looks for this line: the gateway's user reached the key service (bots/README.md, Deploying).
    console.log(JSON.stringify({ gateway: "secrets_ready" }));
    return grants;
  } catch (error) {
    console.error(JSON.stringify({ gateway: "secrets_unavailable", reason: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
    return undefined;
  }
}
const secrets = await startSecrets();
if (secrets) setInterval(() => void secrets.poll().catch(() => undefined), SECRET_POLL_MS);

// Budgets persist on the gateway's own volume. An unreadable budget file stops the start (fails closed) with one
// operator line naming the file and the recovery; the non-zero exit keeps Docker restarting it, each time logged.
function startGateway(): Gateway {
  try {
    return new Gateway(cfg, {
      store: fileBudgetStore(cfg.budgetFile),
      ownerStore: cfg.ownersFile ? fileOwnerStore(cfg.ownersFile) : undefined,
      verifiedFetch: aci ? (botId, url, init) => aci.fetch(botId, url, init) : undefined,
      secrets,
      secretNet: networkDeps,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        gateway: "refusing_to_start",
        reason: error instanceof Error ? error.message : "unknown",
        fix: "budget counters cannot be restored; see 'Budget file recovery' in bots/README.md",
      }),
    );
    process.exit(78);
  }
}
const gateway = startGateway();
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
      // Until the request is accepted and its body read, Bun's default idle timeout (10 s without a byte) cuts slow
      // headers and bodies, and the gateway's own body deadline bounds the total. Only then can the response sit
      // quiet while the model thinks; the upstream total deadline bounds it instead.
      return gateway.handle(botId, req, () => server.timeout(req, 0));
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
  maxRequestBodySize: MAX_ADMISSION_BYTES,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === ADMISSION_CONTROL_PATH) return admit(req);
    const receiptMatch = /^\/bots\/([0-9a-f]{64})\/receipts$/.exec(pathname);
    if (req.method === "GET" && receiptMatch) return Response.json(aci?.take(receiptMatch[1]!) ?? []);
    const secretMatch = SECRETS_ROUTE.exec(pathname);
    if (secretMatch) return secretRoute(req, secretMatch[1]!, secretMatch[2]!, secrets, botId => gateway.ownerOf(botId));
    const asksMatch = /^\/bots\/([0-9a-f]{64})\/asks(\/drain)?$/.exec(pathname);
    if (asksMatch) {
      const asksBot = asksMatch[1]!;
      if (asksMatch[2] && req.method === "POST") return Response.json({ asks: gateway.drainAsks(asksBot), outside: gateway.asksOutside(asksBot) });
      if (!asksMatch[2] && req.method === "PUT") {
        const push = parseAsksPush(await req.json().catch(() => null));
        if (!push) return new Response(null, { status: 400 });
        gateway.setAsks(asksBot, push);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }
    const webMatch = /^\/bots\/([0-9a-f]{64})\/web(\/addresses)?$/.exec(pathname);
    if (webMatch) {
      const webBot = webMatch[1]!;
      if (!webMatch[2] && req.method === "GET") return Response.json({ available: gateway.webAvailable, today: gateway.webUsage(webBot) });
      const input: unknown = await req.json().catch(() => null);
      if (!webMatch[2] && req.method === "PUT") {
        const policy = parseWebPolicy(input);
        if (!policy) return new Response(null, { status: 400 });
        gateway.setWebPolicy(webBot, policy);
        return new Response(null, { status: 204 });
      }
      if (webMatch[2] && req.method === "POST") {
        const urls = isRecord(input) && Array.isArray(input.urls) ? input.urls.slice(0, 50) : undefined;
        if (!urls) return new Response(null, { status: 400 });
        const keys = urls.flatMap(url => {
          const readable = readableAddress(url);
          const key = readable && addressKey(readable.href);
          return key ? [key] : [];
        });
        gateway.learnAddresses(webBot, keys);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    }
    const match = /^\/bots\/([0-9a-f]{64})$/.exec(pathname);
    if (!match) return new Response(null, { status: 404 });
    const botId = match[1]!;
    if (req.method === "DELETE") {
      unlisten(botId);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "PUT") return new Response(null, { status: 405 });
    const body: unknown = await req.json().catch(() => null);
    if (!isRecord(body) || typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token)
      || (body.owner !== undefined && (typeof body.owner !== "string" || !BOT_ID.test(body.owner)))) {
      return new Response(null, { status: 400 });
    }
    listen(botId);
    gateway.setToken(botId, body.token, body.owner as string | undefined);
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
