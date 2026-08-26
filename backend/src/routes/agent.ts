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

const TRANSCRIPT_SQL = "xyz.tinycloud.tinychat/connectors";
const TRANSCRIPT_KV = `${TRANSCRIPT_SQL}/`;
const MAX_TRANSCRIPT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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
    let body: Record<string, unknown>;
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

    const { serialized: legacySerialized, roomId, session } = req.body ?? {};
    const isV2 = isSessionEnvelope(session);
    const serialized = isV2 ? session.delegations.memory : legacySerialized;
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

    if (isV2) {
      if (!signedOwnerMatches(session.delegations.memory, user.address)) {
        res.status(400).json({ error: "wrong_delegator" });
        return;
      }
      const transcript = validateSignedTranscript(session.delegations.transcripts, user.address, config.agentDid);
      if (!transcript.ok) {
        res.status(400).json({ error: transcript.error });
        return;
      }
    }

    // Routing key the service registers and later routes on. Lowercase seed
    // (entity-id.ts) keeps checksummed and lowercase addresses aligned.
    const entityId = addressToEntityId(user.address, agentId);

    try {
      const eliza = await callEliza("POST", "/sessions", {
        agentId,
        entityId,
        ...(isV2
          ? { session: { ...session, ...(roomId ? { roomId } : {}) } }
          : { serializedDelegation: serialized, ...(roomId ? { roomId } : {}) }),
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

/**
 * Decode the (unverified) UCAN payload carried by a serialized delegation.
 *
 * The node verifies the signature on use; decoding here only lets the courier
 * read the SIGNED capability claim instead of the forgeable top-level
 * `resources`/`actions`/`expiry` summary. Never echo any part of it.
 */
function isSessionEnvelope(value: unknown): value is { version: 2; delegations: { memory: string; transcripts: string }; roomId?: string } {
  if (!value || typeof value !== "object") return false;
  const entry = value as { version?: unknown; roomId?: unknown; delegations?: unknown };
  if (!entry.delegations || typeof entry.delegations !== "object") return false;
  const grants = entry.delegations as { memory?: unknown; transcripts?: unknown };
  return entry.version === 2
    && typeof grants.memory === "string"
    && typeof grants.transcripts === "string"
    && (entry.roomId === undefined || typeof entry.roomId === "string");
}

function signedPayload(serialized: string): { att: Record<string, unknown>; exp: number | null } | null {
  try {
    const parsed = JSON.parse(serialized) as { delegationHeader?: { Authorization?: unknown } };
    const auth = parsed.delegationHeader?.Authorization;
    if (typeof auth !== "string") return null;
    const segment = auth.replace(/^Bearer\s+/i, "").split(".")[1];
    if (!segment) return null;
    const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as { att?: unknown; exp?: unknown };
    if (!payload.att || typeof payload.att !== "object" || Array.isArray(payload.att)) return null;
    return {
      att: payload.att as Record<string, unknown>,
      exp: typeof payload.exp === "number" && Number.isFinite(payload.exp) ? payload.exp : null,
    };
  } catch {
    return null;
  }
}

/**
 * Split a UCAN att resource URI into its parts.
 *
 * The canonical form is `<space>/<serviceShort>/<path...>`, where `<space>` is
 * the colon-form space id (`tinycloud:pkh:eip155:1:0x...:default`). A path may
 * itself contain slashes, so only the first two segments are positional.
 */
function parseAttUri(uri: string): { owner: string; service: string; path: string } | null {
  const segments = uri.split("/");
  const space = segments[0] ?? "";
  const service = segments[1] ?? "";
  const owner = space.split(":")[4] ?? "";
  if (!service || !owner) return null;
  return { owner, service, path: segments.slice(2).join("/") };
}

function attGrants(att: Record<string, unknown>): Array<{ owner: string; service: string; path: string; actions: string[] }> | null {
  const grants: Array<{ owner: string; service: string; path: string; actions: string[] }> = [];
  for (const [uri, abilities] of Object.entries(att)) {
    if (!abilities || typeof abilities !== "object" || Array.isArray(abilities)) return null;
    const actions = Object.keys(abilities as Record<string, unknown>);
    if (actions.length === 0) continue;
    const parsed = parseAttUri(uri);
    if (!parsed) return null;
    grants.push({ ...parsed, actions });
  }
  return grants;
}

/**
 * Read the exact child attenuation carried by the SDK's `Bearer <cid>` form.
 * The TinyCloud host verifies this attenuation against the signed CID parent
 * when the agent activates it; a wider forgery cannot activate, while a
 * narrower one only reduces the resulting child session.
 */
function cidBackedGrants(serialized: string): Array<{ owner: string; service: string; path: string; actions: string[] }> | null {
  try {
    const parsed = JSON.parse(serialized) as {
      cid?: unknown;
      delegationHeader?: { Authorization?: unknown };
      resources?: unknown;
    };
    const auth = parsed.delegationHeader?.Authorization;
    if (typeof auth !== "string" || typeof parsed.cid !== "string") return null;
    const bearer = auth.replace(/^Bearer\s+/i, "");
    if (bearer.includes(".") || bearer !== parsed.cid || !Array.isArray(parsed.resources)) return null;

    const grants: Array<{ owner: string; service: string; path: string; actions: string[] }> = [];
    for (const resource of parsed.resources) {
      if (!resource || typeof resource !== "object") return null;
      const entry = resource as { service?: unknown; space?: unknown; path?: unknown; actions?: unknown };
      if (
        typeof entry.service !== "string" ||
        typeof entry.space !== "string" ||
        typeof entry.path !== "string" ||
        !Array.isArray(entry.actions) ||
        !entry.actions.every((action) => typeof action === "string")
      ) return null;
      const owner = entry.space.split(":")[4] ?? "";
      if (!owner) return null;
      grants.push({
        owner,
        service: entry.service.replace(/^tinycloud\./, ""),
        path: entry.path,
        actions: [...entry.actions],
      });
    }
    return grants.length > 0 ? grants : null;
  } catch {
    return null;
  }
}

function signedOwnerMatches(serialized: string, owner: string): boolean {
  const payload = signedPayload(serialized);
  if (!payload) return false;
  const grants = attGrants(payload.att);
  if (!grants || grants.length === 0) return false;
  return grants.every((grant) => normalizeAddress(grant.owner) === normalizeAddress(owner));
}

/**
 * The exact transcript ceiling this backend will courier.
 *
 * Every entry is required except `capabilities`, which the SDK mints as part of
 * its own capability chain at a path it chooses. That entry is read-only and
 * conveys no user data, so it is permitted at any path; every user-data
 * resource stays pinned to an exact service/path/action set.
 */
const TRANSCRIPT_CEILING: Array<{ service: string; path: string | null; actions: Set<string>; required: boolean }> = [
  { service: "sql", path: TRANSCRIPT_SQL, actions: new Set(["tinycloud.sql/read"]), required: true },
  { service: "kv", path: TRANSCRIPT_KV, actions: new Set(["tinycloud.kv/get", "tinycloud.kv/list"]), required: true },
  { service: "capabilities", path: null, actions: new Set(["tinycloud.capabilities/read"]), required: false },
];

/**
 * Enforce the local courier ceiling from either the inline signed claim or the
 * SDK's CID-backed child attenuation.
 *
 * TinyChat never activates this grant; the node verifies it cryptographically
 * on use. This courier gate checks the inline signed claim when available, or
 * the exact CID child request otherwise. In both forms it requires the
 * authenticated owner, configured agent, seven-day ceiling, and fixed
 * transcript policy; the host remains the cryptographic authority.
 */
function validateSignedTranscript(serialized: string, owner: string, agentDid: string): { ok: true } | { ok: false; error: string } {
  let parsed: { delegateDID?: unknown; expiry?: unknown };
  try {
    parsed = JSON.parse(serialized) as { delegateDID?: unknown; expiry?: unknown };
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof parsed.delegateDID !== "string" || normalizeDid(parsed.delegateDID) !== normalizeDid(agentDid)) {
    return { ok: false, error: "wrong_delegatee" };
  }
  const summaryExpiry = new Date(parsed.expiry as string);
  if (!Number.isFinite(summaryExpiry.getTime()) || summaryExpiry <= new Date()) {
    return { ok: false, error: "delegation_expired" };
  }

  const payload = signedPayload(serialized);
  const signedExpiryMs = payload?.exp === null || payload === null ? null : payload.exp * 1_000;
  // Inline UCANs carry a signed expiry. CID-backed grants are activated into a
  // child session by the agent and use the bounded portable expiry here.
  const effectiveExpiryMs = signedExpiryMs === null
    ? summaryExpiry.getTime()
    : Math.max(summaryExpiry.getTime(), signedExpiryMs);
  if (signedExpiryMs !== null && signedExpiryMs <= Date.now()) return { ok: false, error: "delegation_expired" };
  if (effectiveExpiryMs - Date.now() > MAX_TRANSCRIPT_EXPIRY_MS) {
    return { ok: false, error: "delegation_expiry_too_long" };
  }

  const grants = payload ? attGrants(payload.att) : cidBackedGrants(serialized);
  if (!grants || grants.length === 0) return { ok: false, error: "malformed" };

  const seen = new Set<string>();
  for (const grant of grants) {
    if (normalizeAddress(grant.owner) !== normalizeAddress(owner)) return { ok: false, error: "wrong_delegator" };
    const allowed = TRANSCRIPT_CEILING.find((entry) =>
      entry.service === grant.service && (entry.path === null || entry.path === grant.path));
    if (!allowed || seen.has(allowed.service)) return { ok: false, error: "transcript_policy_exceeded" };
    if (grant.actions.some((action) => !allowed.actions.has(action))) {
      return { ok: false, error: "transcript_policy_exceeded" };
    }
    seen.add(allowed.service);
  }
  if (TRANSCRIPT_CEILING.some((entry) => entry.required && !seen.has(entry.service))) {
    return { ok: false, error: "transcript_policy_exceeded" };
  }
  return { ok: true };
}

function requireUser(req: Request, res: Response): { address: string } | null {
  if (!req.user) {
    res.status(401).json({ error: "unauthenticated", message: "Authentication required" });
    return null;
  }
  return req.user;
}
