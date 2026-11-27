// Gateway-owned Courier runtime. Every owner and peer lookup is fresh; no process-global Courier profile.
// Details: TC-4058
import { dirname, join } from "node:path";
import type { GatewayConfig } from "../config";
import { sealKeyFromDstack } from "../dstack-key";
import { type Gateway, readBody } from "../gateway";
import { isRecord } from "../guards";
import type { MeetingDesk } from "../meeting-reads";
import { OWNER_DID } from "../owner";
import { createCourierControl } from "./control";
import { deniedChatIds, enabledReadAreas } from "./denied-chats";
import { createCourierGrantStore } from "./grant-store";
import { CourierIntake, courierIntakeStore, courierPeerHash } from "./intake";
import { COURIER_ANSWER_BUDGET, COURIER_BUSY, CourierFixedReply } from "./guard";
import { acknowledgeInbound, courierContext, listInbound, sendMessage } from "./lib-adapter";
import { courierPeerControl, createCourierPairing } from "./pairing";
import { createCourierPeerStore } from "./peer-store";
import { replyToCourierThread } from "./reply";
import { courierTurn } from "./turn";

/** A pass can wait on a peer's turn for up to 90 s; an erase waits less than the supervisor's own deadline for it. */
const ERASE_PASS_WAIT_MS = 25_000;

export interface CourierGateway {
  /** One pass over pairing upkeep and intake; joins a pass already running. */
  tick(): Promise<void>;
  stop(): void;
  control(req: Request): Promise<Response | undefined>;
  /**
   * Account erase: the owner's grant, peers, SDK records and intake state, in memory and on disk, with nothing written
   * to the owner's space. Throws unless all of it is gone; call again.
   */
  erase(owner: string): Promise<void>;
}

/** The peer store holds an exclusive lock on its directory: a failed start must release it. */
function closeOnThrow<T>(peers: { close(): void }, make: () => T): T {
  try { return make(); } catch (error) { peers.close(); throw error; }
}

export async function startCourierGateway(options: { cfg: GatewayConfig; gateway: Gateway; reads: MeetingDesk; env: Record<string, string | undefined>; sealKey?: () => Promise<Uint8Array> }): Promise<CourierGateway> {
  const owners = [...new Set((options.env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(address => address.trim().toLowerCase()).filter(address => /^0x[0-9a-f]{40}$/.test(address)).map(address => `did:pkh:eip155:1:${address}`))];
  const allowed = new Set(owners);
  const key = await (options.sealKey ?? sealKeyFromDstack)();
  const root = dirname(options.cfg.budgetFile);
  const grants = createCourierGrantStore(join(root, "courier-grants"), key);
  const peers = createCourierPeerStore(join(root, "courier-peers"), key);
  const pairing = createCourierPairing({ store: peers, grants });
  const control = createCourierControl(grants);
  const intake = closeOnThrow(peers, () => new CourierIntake({
    owners, grants, peers, store: courierIntakeStore(join(root, "courier-intake"), key),
    async transport(owner, grant, peer) {
      const runtime = await peers.getRuntime(owner, peer.handle);
      if (!runtime || runtime.peerDid !== peer.peerDid || runtime.delegationExpiresAt <= Date.now()) throw new Error("courier_peer_ended");
      const context = await courierContext(owner, grant, peers);
      return {
        async inbox() {
          return (await listInbound(context, runtime)).map(message => ({ id: message.messageId, threadId: message.threadId, kind: message.intent, text: message.text }));
        },
        async acknowledge(message) { await acknowledgeInbound(context, runtime, [{ threadId: message.threadId, messageId: message.id }]); },
        async reply(message, text) {
          const current = await peers.getRuntime(owner, peer.handle);
          const currentGrant = await grants.get(owner);
          if (!current || current.peerDid !== runtime.peerDid || current.delegationExpiresAt <= Date.now() || !currentGrant || currentGrant.expiresAt <= Date.now()) throw new Error("courier_peer_ended");
          const freshContext = await courierContext(owner, currentGrant, peers);
          await replyToCourierThread(freshContext, current, message, text, sendMessage);
        },
      };
    },
    async turn(owner, peer, message, signal) {
      return courierTurn({ owner, handle: peer.handle, peerDid: peer.peerDid, threadId: message.threadId, text: message.text, signal, reads: options.reads, deniedChatIds, enabledReadAreas,
        async model(body) {
          const response = await options.gateway.courierModel(owner, courierPeerHash(peer.peerDid), { ...body, model: options.cfg.models[0], max_tokens: options.cfg.maxTokens });
          if (!response.ok) {
            await response.body?.cancel();
            // Main's shared allowance or its one slot: the asking agent gets a fixed sentence, not silence.
            const refusal = response.headers.get("x-courier-refusal");
            if (response.status === 429 && refusal === "budget") throw new CourierFixedReply(COURIER_ANSWER_BUDGET);
            if (response.status === 429 && refusal === "concurrency") throw new CourierFixedReply(COURIER_BUSY);
            throw new Error("courier_model_unavailable");
          }
          const bytes = await readBody(response, options.cfg.maxResponseBytes, options.cfg.totalTimeoutMs);
          if (typeof bytes === "string") throw new Error("courier_model_unavailable");
          const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
          const first = isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : undefined;
          if (!isRecord(first) || !isRecord(first.message)) throw new Error("courier_model_unavailable");
          return first.message;
        },
      });
    },
  }));
  let running: Promise<void> | undefined;
  // One pass at a time: a caller during a pass joins it. The 15 s timer and the loopback test share this.
  const tick = () => running ??= (async () => {
    try {
      for (const owner of owners) await pairing.maintain(owner).catch(() => {});
      await intake.poll();
    } finally { running = undefined; }
  })();
  void tick().catch(() => {});
  const timer = setInterval(() => void tick().catch(() => {}), 15_000);
  timer.unref();
  return {
    tick,
    stop() { clearInterval(timer); peers.close(); },
    async erase(owner) {
      await pairing.erase(owner);
      // A pass saves the intake state it holds, so intake is cleared only once none is running. The owner has no grant
      // now, so a pass that starts later does nothing for them.
      const pass = running;
      if (pass && !(await Promise.race([pass.then(() => true, () => true), Bun.sleep(ERASE_PASS_WAIT_MS).then(() => false)]))) {
        throw new Error("courier_pass_running");
      }
      intake.eraseOwner(owner);
    },
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
