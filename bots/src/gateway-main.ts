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
//   PUT    /bots/<botId>/reads  {"areas", "owner"?, "conversation"}  the owner's read setting for Main (TrustBot) and the
//                         id of its conversation (applies from the bot's next call)
//   GET    /bots/<botId>/reads                   {"held"}: whether its current conversation holds owner data it read
//   PUT    /bots/<botId>/actions  {"keys"?, "ownerTurn"?, "pending", "feedback"?, "day", "today", "final"}  for `propose_action`:
//                         the recipients Main may name this turn and whether the owner started it, the supervisor's counts
//                         and the proposals that are final
//   POST   /bots/<botId>/actions/drain           {"actions"}: the proposals the bot has made since the last drain
//   POST   /bots/<botId>/actions/spend {"id", "binding"}  204 once for an approval the gateway issued with that binding, else 409
//   POST   /bots/<botId>/actions/send {"id", "binding", "body"}  {"outcome", "reportId"?, "code"?}: posts an approved feedback
//                         report once (feedback.ts), after checking and spending its approval
//   PUT|DELETE /bots/<botId>/secrets/<id>, POST /bots/<botId>/secrets/drain   secret requests (secret-routes.ts)

import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { BotAci } from "./aci";
import { ADMISSION_CONTROL_PATH, createAdmissionRelay } from "./bot-admission";
import { fileActionLedgerStore } from "./actions-desk";
import { parseActionsPush } from "./actions";
import { gatewayConfig, SECRET_ORIGINS } from "./config";
import { sealKeyFromDstack } from "./dstack-key";
import { networkDeps } from "./fetch-net";
import { fileBudgetStore, fileOwnerStore, Gateway } from "./gateway";
import { fileHeldStore, MeetingDesk } from "./meeting-reads";
import { parseReadsPush } from "./reads";
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
import { startCourierGateway, type CourierGateway } from "./courier/runtime";
import { courierPeerHash } from "./courier/intake";

/**
 * The control socket's largest request body, for every route on it: a feedback report's body (up to 8 KB, JSON-escaped)
 * on /actions/send, actions pushes with their final hashes and Courier bodies. The admission relay keeps its own
 * 512-byte cap (bot-admission.ts). Only the supervisor reaches this socket.
 */
const CONTROL_MAX_BODY_BYTES = 32 * 1024;

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
    const grants = new SecretGrants({ store: sealedGrantStore(cfg.secretGrantsDir!, key), reader: nodeSecretReader(SECRET_ORIGINS.node), origins: SECRET_ORIGINS });
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
function startGateway(): { gateway: Gateway; reads: MeetingDesk } {
  try {
    const reads = new MeetingDesk({
      backendOrigin, backendCallSecret, forwardRefusals: true,
      store: fileHeldStore(join(dirname(cfg.budgetFile), "held.json")),
    });
    return { gateway: new Gateway(cfg, {
      store: fileBudgetStore(cfg.budgetFile),
      ownerStore: cfg.ownersFile ? fileOwnerStore(cfg.ownersFile) : undefined,
      // Which conversations hold the owner's data, beside the budget file; an unreadable file stops the start.
      meetings: reads,
      actionStore: fileActionLedgerStore(join(dirname(cfg.budgetFile), "actions.json")),
      verifiedFetch: aci ? (botId, url, init) => aci.fetch(botId, url, init) : undefined,
      secrets,
      secretNet: networkDeps,
    }), reads };
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
const { gateway, reads } = startGateway();
let courier: CourierGateway | undefined;
if (process.env.BOTS_COURIER_ENABLED === "true") {
  try { courier = await startCourierGateway({ cfg, gateway, reads, env: process.env }); }
  catch { console.error(JSON.stringify({ gateway: "courier", peer: courierPeerHash(""), outcome: "unavailable" })); }
}
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
  maxRequestBodySize: CONTROL_MAX_BODY_BYTES,
  async fetch(req, server) {
    const { pathname } = new URL(req.url);
    if (pathname.startsWith("/courier/")) {
      try { return await courier?.control(req) ?? new Response(null, { status: 404 }); }
      catch { return new Response(null, { status: 503 }); }
    }
    if (pathname === ADMISSION_CONTROL_PATH) return admit(req);
    const receiptMatch = /^\/bots\/([0-9a-f]{64})\/receipts$/.exec(pathname);
    if (req.method === "GET" && receiptMatch) return Response.json(aci?.take(receiptMatch[1]!) ?? []);
    const readsMatch = /^\/bots\/([0-9a-f]{64})\/reads$/.exec(pathname);
    if (readsMatch) {
      if (req.method === "GET") return Response.json({ held: gateway.readsHeld(readsMatch[1]!) });
      if (req.method !== "PUT") return new Response(null, { status: 405 });
      const push = parseReadsPush(await req.json().catch(() => null));
      if (!push || !gateway.setReads(readsMatch[1]!, push)) return new Response(null, { status: 400 });
      return new Response(null, { status: 204 });
    }

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
    const actionsMatch = /^\/bots\/([0-9a-f]{64})\/actions(\/drain|\/spend|\/send)?$/.exec(pathname);
    if (actionsMatch) {
      const actionsBot = actionsMatch[1]!;
      if (actionsMatch[2] === "/drain" && req.method === "POST") return Response.json({ actions: gateway.drainActions(actionsBot) });
      if (actionsMatch[2] === "/spend" && req.method === "POST") {
        const input: unknown = await req.json().catch(() => null);
        if (!isRecord(input) || typeof input.id !== "string" || typeof input.binding !== "string") return new Response(null, { status: 400 });
        return new Response(null, { status: gateway.spendAction(actionsBot, input.id, input.binding) ? 204 : 409 });
      }
      if (actionsMatch[2] === "/send" && req.method === "POST") {
        // One POST of up to 15 s to the feedback service; Bun's 10 s idle timeout would cut the supervisor's call first.
        server.timeout(req, 30);
        const input: unknown = await req.json().catch(() => null);
        if (!isRecord(input) || typeof input.id !== "string" || typeof input.binding !== "string" || typeof input.body !== "string") return new Response(null, { status: 400 });
        return Response.json(await gateway.sendFeedback(actionsBot, input.id, input.binding, input.body));
      }
      if (!actionsMatch[2] && req.method === "PUT") {
        const push = parseActionsPush(await req.json().catch(() => null));
        if (!push) return new Response(null, { status: 400 });
        gateway.setActions(actionsBot, push);
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
    courier?.stop();
    for (const botId of [...listeners.keys()]) unlisten(botId);
    void control.stop(true);
    process.exit(0);
  });
}
