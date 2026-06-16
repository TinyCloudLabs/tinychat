// /api/agent — direct-to-agent delegation courier (Milestone E, §6).
//
// Decision 1 (DIRECT delegation): the user's wallet mints ONE tinycloud.sql
// delegation whose delegatee is the AGENT DID (not the backend). tinychat cannot
// USE it (WRONG_DELEGATEE) — it only couriers the serialized delegation to
// eliza-service POST /sessions. There is NO backend-node activation here (that was
// the chained model the legacy routes/delegations.ts implements; this supersedes
// it for the agent flow).
//
// The backend derives the routing entityId = addressToEntityId(user.address,
// agentId) — byte-identical to what eliza-service routes on (entity-id.ts) — and
// sends it alongside the serialized delegation under the service credential.
//
// Endpoints:
//   POST /api/agent/session  — courier a freshly minted delegation to eliza /sessions
//   GET  /api/agent/session  — delegation liveness (proxies eliza GET /sessions/:entityId)
//                              for the re-mint UX (decision 4)

import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";
import { createAgentChatHandler, type AgentChatConfig } from "./agent-chat.js";
import {
  deserializePortableDelegationSet,
  extractPortableDelegationIdentity,
  normalizeAddress,
  normalizeDid,
  type PortableDelegationSet,
} from "../portable-delegation.js";

export interface AgentRoutesConfig {
  /** The agent did:pkh all users delegate to (eliza-service's stable identity). */
  agentDid: string;
  /** Base URL of eliza-service (no trailing slash), e.g. https://eliza.internal. */
  elizaServiceUrl: string;
  /** Shared service credential for the Layer-1 gate. NEVER logged or echoed. */
  elizaServiceSecret: string;
  authMiddleware: RequestHandler;
  /** Frozen tinychat character/agent id used to derive the entityId. */
  agentId?: string;
  /** Injectable fetch (tests stub eliza-service). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable deserializer (tests pass JSON.parse). */
  deserializeDelegationSet?: (serialized: string) => PortableDelegationSet;
  /**
   * When provided, mounts POST /chat (the tool-calling orchestration around the
   * RedPill relay). Omitted when REDPILL_API_KEY is absent.
   */
  chat?: AgentChatConfig;
}

interface ElizaResponse {
  status: number;
  body: Record<string, unknown>;
}

export function createAgentRouter(config: AgentRoutesConfig) {
  const router = Router();
  router.use(config.authMiddleware);

  const agentId = config.agentId ?? TINYCHAT_AGENT_ID;
  const fetchImpl = config.fetchImpl ?? fetch;
  const deserialize = config.deserializeDelegationSet ?? deserializePortableDelegationSet;

  if (config.chat) {
    router.post("/chat", createAgentChatHandler(config.chat));
  }

  async function callEliza(
    method: "POST" | "GET",
    path: string,
    payload?: unknown,
  ): Promise<ElizaResponse> {
    const res = await fetchImpl(`${config.elizaServiceUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.elizaServiceSecret}`,
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: res.status, body };
  }

  router.post("/session", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const { serialized, roomId } = req.body ?? {};
    if (typeof serialized !== "string" || serialized.length === 0) {
      res.status(400).json({
        error: "invalid_body",
        message: "Request body must include a serialized delegation",
      });
      return;
    }
    if (roomId !== undefined && typeof roomId !== "string") {
      res.status(400).json({ error: "invalid_body", message: "roomId must be a string" });
      return;
    }

    let identity: ReturnType<typeof extractPortableDelegationIdentity>;
    try {
      identity = extractPortableDelegationIdentity(deserialize(serialized));
    } catch (error) {
      console.error("[agent] failed to deserialize delegation:", error);
      res.status(400).json({ error: "malformed", message: "Failed to parse delegation" });
      return;
    }

    if (!identity) {
      res.status(400).json({
        error: "invalid_delegation_identity",
        message: "Delegation does not expose a consistent owner and delegatee",
      });
      return;
    }

    if (normalizeAddress(identity.ownerAddress) !== normalizeAddress(user.address)) {
      res.status(400).json({
        error: "wrong_delegator",
        message: "Delegation owner does not match the authenticated user",
        expected: user.address,
        actual: identity.ownerAddress,
      });
      return;
    }

    // Direct-to-agent: the delegatee MUST be the agent DID, not the backend.
    if (normalizeDid(identity.delegateDID) !== normalizeDid(config.agentDid)) {
      res.status(400).json({
        error: "wrong_delegatee",
        message: "Delegation delegatee must be the agent DID",
        expected: config.agentDid,
        actual: identity.delegateDID,
      });
      return;
    }

    // Routing key the service registers and later routes on. Lowercase seed
    // (entity-id.ts) keeps checksummed and lowercase addresses aligned.
    const entityId = addressToEntityId(user.address, agentId);

    try {
      const eliza = await callEliza("POST", "/sessions", {
        agentId,
        entityId,
        serializedDelegation: serialized,
        ...(roomId ? { roomId } : {}),
      });
      // Pass through eliza-service's status + body (200 {entityId, status} or the
      // contract's error codes: 400 wrong_delegatee/delegation_expired/invalid_shape, 401/403).
      res.status(eliza.status).json(eliza.body);
    } catch (error) {
      console.error("[agent] eliza-service /sessions unreachable:", error);
      res.status(502).json({ error: "eliza_unreachable" });
    }
  });

  router.get("/session", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;

    const entityId = addressToEntityId(user.address, agentId);
    try {
      const eliza = await callEliza("GET", `/sessions/${encodeURIComponent(entityId)}`);
      // Liveness normalization: "no session yet" is a valid answer, NOT an error.
      // eliza returns 404 {status:"none"} for an un-minted entityId; passing that
      // 404 through makes the frontend capability probe classify the route as
      // absent and hide the Enable affordance. Whenever eliza gives a structured
      // {status} body, surface it as 200 so the probe reads the liveness state;
      // only non-structured responses keep eliza's status.
      const status = (eliza.body as { status?: unknown } | undefined)?.status;
      if (typeof status === "string") {
        res.status(200).json(eliza.body);
      } else {
        res.status(eliza.status).json(eliza.body);
      }
    } catch (error) {
      console.error("[agent] eliza-service GET /sessions unreachable:", error);
      res.status(502).json({ error: "eliza_unreachable" });
    }
  });

  return router;
}

function requireUser(req: Request, res: Response): { address: string } | null {
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return req.user;
}
