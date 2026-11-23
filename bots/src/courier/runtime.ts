// Gateway-owned Courier runtime. Every owner and peer lookup is fresh; no process-global Courier profile.
// Details: TC-4058
import { dirname, join } from "node:path";
import type { GatewayConfig } from "../config";
import { sealKeyFromDstack } from "../dstack-key";
import { type Gateway, readBody } from "../gateway";
import { isRecord } from "../guards";
import type { MeetingDesk } from "../meeting-reads";
import { botIdFor, OWNER_DID } from "../owner";
import { createCourierControl } from "./control";
import { deniedChatIds, enabledReadAreas } from "./denied-chats";
import { createCourierGrantStore } from "./grant-store";
import { CourierIntake, courierIntakeStore, courierPeerHash } from "./intake";
import { acknowledgeInbound, courierContext, listInbound, sendMessage } from "./lib-adapter";
import { courierPeerControl, createCourierPairing } from "./pairing";
import { createCourierPeerStore } from "./peer-store";
import { replyToCourierThread } from "./reply";
import { courierTurn } from "./turn";

export interface CourierGateway {
  stop(): void;
  control(req: Request): Promise<Response | undefined>;
}

export async function startCourierGateway(options: { cfg: GatewayConfig; gateway: Gateway; reads: MeetingDesk; env: Record<string, string | undefined> }): Promise<CourierGateway> {
  const owners = [...new Set((options.env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(address => address.trim().toLowerCase()).filter(address => /^0x[0-9a-f]{40}$/.test(address)).map(address => `did:pkh:eip155:1:${address}`))];
  const allowed = new Set(owners);
  const key = await sealKeyFromDstack();
  const root = dirname(options.cfg.budgetFile);
  const grants = createCourierGrantStore(join(root, "courier-grants"), key);
  const peers = createCourierPeerStore(join(root, "courier-peers"), key);
  const pairing = createCourierPairing({ store: peers, grants });
  const control = createCourierControl(grants);
  const intake = new CourierIntake({
    owners, grants, peers, store: courierIntakeStore(join(root, "courier-intake"), key),
    async transport(owner, grant, peer) {
      const runtime = await peers.getRuntime(owner, peer.handle);
      if (!runtime || runtime.peerDid !== peer.peerDid || runtime.delegationExpiresAt <= Date.now()) throw new Error("courier_peer_ended");
      const context = await courierContext(owner, grant);
      return {
        async inbox() {
          return (await listInbound(context, runtime)).map(message => ({ id: message.messageId, threadId: message.threadId, kind: message.intent, text: message.text }));
        },
        async acknowledge(message) { await acknowledgeInbound(context, runtime, [{ threadId: message.threadId, messageId: message.id }]); },
        async reply(message, text) {
          const current = await peers.getRuntime(owner, peer.handle);
          const currentGrant = await grants.get(owner);
          if (!current || current.peerDid !== runtime.peerDid || current.delegationExpiresAt <= Date.now() || !currentGrant || currentGrant.expiresAt <= Date.now()) throw new Error("courier_peer_ended");
          const freshContext = await courierContext(owner, currentGrant);
          await replyToCourierThread(freshContext, current, message, text, sendMessage);
        },
      };
    },
    async turn(owner, peer, message) {
      return courierTurn({ owner, handle: peer.handle, peerDid: peer.peerDid, threadId: message.threadId, text: message.text, reads: options.reads, deniedChatIds, enabledReadAreas,
        async model(body) {
          const response = await options.gateway.courierModel(botIdFor(owner), courierPeerHash(peer.peerDid), { ...body, model: options.cfg.models[0], max_tokens: options.cfg.maxTokens });
          if (!response.ok) { await response.body?.cancel(); throw new Error("courier_model_unavailable"); }
          const bytes = await readBody(response, options.cfg.maxResponseBytes, options.cfg.totalTimeoutMs);
          if (typeof bytes === "string") throw new Error("courier_model_unavailable");
          const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
          const first = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
          if (!isRecord(first) || !isRecord(first.message)) throw new Error("courier_model_unavailable");
          return first.message;
        },
      });
    },
  });
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const owner of owners) await pairing.maintain(owner).catch(() => {});
      await intake.poll();
    } finally { ticking = false; }
  };
  void tick().catch(() => {});
  const timer = setInterval(() => void tick().catch(() => {}), 15_000);
  timer.unref();
  return {
    stop() { clearInterval(timer); },
    async control(req: Request): Promise<Response | undefined> {
      const match = /^\/courier\/([^/]+)(\/.*)$/.exec(new URL(req.url).pathname);
      if (!match) return undefined;
      let owner: string;
      try { owner = decodeURIComponent(match[1]!); } catch { return new Response(null, { status: 404 }); }
      if (!OWNER_DID.test(owner) || !allowed.has(owner)) return new Response(null, { status: 404 });
      const suffix = match[2]!;
      const thread = /^\/threads(?:\/([0-9a-f]{64}))?$/.exec(suffix);
      if (thread) {
        const id = thread[1];
        if (req.method === "DELETE" && id) { intake.deleteThread(owner, id); return new Response(null, { status: 204 }); }
        if (req.method !== "GET") return new Response(null, { status: 405 });
        if (id) {
          const found = intake.thread(owner, id);
          return found ? Response.json(found) : new Response(null, { status: 404 });
        }
        return Response.json({ threads: intake.threadSummaries(owner) });
      }
      return await courierPeerControl(req, owner, suffix, pairing) ?? await control(req);
    },
  };
}
