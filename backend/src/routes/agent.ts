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
//                              for the re-mint UX (decision 4); bounded by a 3s timeout

import { SESSION_EXPIRATION_MS } from "@tinyboilerplate/core";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";
import { createAgentChatHandler, type AgentChatConfig } from "./agent-chat.js";
import { McpPortError } from "../mcp-meetings/port.js";
import type { McpChatWiring } from "../mcp-meetings/config.js";
import {
  deserializePortableDelegationSet,
  extractPortableDelegationIdentity,
  normalizeAddress,
  normalizeDid,
  type PortableDelegationSet,
} from "../portable-delegation.js";

const TRANSCRIPT_SQL = "xyz.tinycloud.tinychat/connectors";
const TRANSCRIPT_KV = `${TRANSCRIPT_SQL}/`;
const MAX_TRANSCRIPT_EXPIRY_MS = SESSION_EXPIRATION_MS;
/**
 * Bound on eliza's GET /sessions/:entityId, an in-memory lookup. The chat
 * route awaits it before opening every stream. POST and DELETE stay
 * unbounded: activation and teardown reach the TinyCloud node (666b5c8).
 */
const SESSION_STATUS_TIMEOUT_MS = 3_000;

export interface AgentRoutesConfig {
  /** The agent did:pkh all users delegate to (eliza-service's stable identity). Absent when eliza-service is not configured. */
  agentDid?: string;
  /** Base URL of eliza-service (no trailing slash), e.g. https://eliza.internal. Absent when eliza-service is not configured. */
  elizaServiceUrl?: string;
  /** Shared service credential for the Layer-1 gate. NEVER logged or echoed. */
  elizaServiceSecret?: string;
  /** MCP chat wiring (MCP_CHAT_ENABLED). Accounts it admits never touch eliza-service; everyone else keeps the eliza path. */
  mcp?: McpChatWiring;
  authMiddleware: RequestHandler;
  /** The paid-chat rate limiter (`applyRateLimiters`), run before the chat handler. */
  paidLimiter?: RequestHandler;
  /** Frozen tinychat character/agent id used to derive the entityId. */
  agentId?: string;
  /** Injectable fetch (tests stub eliza-service). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable deserializer (tests pass JSON.parse). */
  deserializeDelegationSet?: (serialized: string) => PortableDelegationSet;
  /** Timeout for session status reads (default 3s; tests shorten it). */
  sessionStatusTimeoutMs?: number;
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
  const statusTimeoutMs = config.sessionStatusTimeoutMs ?? SESSION_STATUS_TIMEOUT_MS;

  // Each running turn belongs to one account generation. Invalidation is local
  // and synchronous; the service remains the authority for private admission.
  const turns = new Map<string, { current: boolean; callbacks: Set<() => void> }>();
  const invalidate = (entityId: string) => {
    const entry = turns.get(entityId);
    if (!entry) return;
    entry.current = false;
    turns.delete(entityId);
    for (const callback of entry.callbacks) callback();
  };
  if (config.chat) {
    router.post("/chat", config.paidLimiter ?? ((_req, _res, next) => next()), createAgentChatHandler(config.chat, {
      capture(entityId) {
        const entry = turns.get(entityId) ?? { current: true, callbacks: new Set<() => void>() };
        turns.set(entityId, entry);
        return { isCurrent: () => entry.current, onInvalidate(callback) {
          entry.callbacks.add(callback);
          return () => { entry.callbacks.delete(callback); if (!entry.callbacks.size && turns.get(entityId) === entry) turns.delete(entityId); };
        } };
      },
      async status(entityId) {
        const result = await callEliza("GET", `/sessions/${encodeURIComponent(entityId)}`, undefined, statusTimeoutMs);
        // 404 {status:"none"} is eliza's definite answer for an un-minted or
        // disconnected entity, not a failed check.
        if ((result.status === 200 || result.status === 404) && typeof result.body.status === "string") return result.body;
        // 400 means the stored grant no longer passes policy: definitely unusable.
        if (result.status === 400 && typeof result.body.error === "string") return { status: "invalid" };
        // Anything else is unknown; the chat route reports it as unverified.
        throw new Error(`session status unavailable (${result.status})`);
      },
    }));
  }

  /** `timeoutMs` bounds the whole exchange, including a fetch that ignores its signal. */
  async function callEliza(
    method: "POST" | "GET" | "DELETE",
    path: string,
    payload?: unknown,
    timeoutMs?: number,
  ): Promise<ElizaResponse> {
    if (!config.elizaServiceUrl || !config.elizaServiceSecret) return { status: 503, body: { error: "eliza_unavailable" } };
    const signal = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
    const exchange = (async (): Promise<ElizaResponse> => {
      const res = await fetchImpl(`${config.elizaServiceUrl}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.elizaServiceSecret}`,
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        ...(signal ? { signal } : {}),
      });
      let body: Record<string, unknown>;
      try {
        const parsed: unknown = await res.json();
        body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        body = {};
      }
      return { status: res.status, body };
    })();
    if (!signal) return exchange;
    return new Promise<ElizaResponse>((resolve, reject) => {
      const timedOut = () => reject(signal.reason ?? new Error("eliza request timed out"));
      if (signal.aborted) { timedOut(); return; }
      signal.addEventListener("abort", timedOut, { once: true });
      exchange.then(resolve, reject).finally(() => signal.removeEventListener("abort", timedOut));
    });
  }

  /** The MCP serves an account only when the operator's flag and account list say so; a failure never changes that. */
  const mcpWiring = (address: string) => {
    const mcp = config.mcp;
    return mcp?.mcpGrants && mcp.mcpMeetings && mcp.mcpOwnerDidFor && mcp.mcpChatAccountAllowed?.(address) === true
      ? { mcpGrants: mcp.mcpGrants, mcpMeetings: mcp.mcpMeetings, mcpOwnerDidFor: mcp.mcpOwnerDidFor } : null;
  };

  router.post("/session", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const mcp = mcpWiring(user.address);
    if (mcp) {
      const delegation = (req.body as { mcp?: { delegation?: unknown } } | undefined)?.mcp?.delegation;
      if (typeof delegation !== "string" || delegation.length === 0) {
        res.status(400).json({ error: "invalid_body", message: "Request body must include mcp.delegation" });
        return;
      }
      let mcpIdentity;
      try {
        mcpIdentity = extractPortableDelegationIdentity(deserialize(delegation));
      } catch {
        res.status(400).json({ error: "malformed", message: "Failed to parse delegation" });
        return;
      }
      if (!mcpIdentity) { res.status(400).json({ error: "invalid_delegation_identity" }); return; }
      if (normalizeAddress(mcpIdentity.ownerAddress) !== normalizeAddress(user.address)) { res.status(400).json({ error: "wrong_delegator" }); return; }
      const checked = validateSignedMcpGrant(delegation, mcp.mcpOwnerDidFor(user.address), mcp.mcpGrants.serviceDid);
      if (!checked.ok) { res.status(400).json({ error: checked.error }); return; }
      try {
        const accepted = await mcp.mcpGrants.accept(delegation);
        // The MCP derives the owner from the signed grant: it must be this session's owner and our service DID.
        if (accepted.ownerDid !== mcp.mcpOwnerDidFor(user.address) || accepted.serviceDid !== mcp.mcpGrants.serviceDid) {
          res.status(502).json({ error: "mcp_grant_mismatch" });
          return;
        }
        res.status(200).json({ status: "active", transcriptStatus: "active", revision: "mcp", expiresAt: accepted.expiresAt });
      } catch (error) {
        const code = error instanceof McpPortError ? error.code : "";
        if (code === "GRANT_EXPIRED") res.status(400).json({ error: "delegation_expired" });
        else if (code === "GRANT_REJECTED" || code === "GRANT_REQUIRED") res.status(400).json({ error: "delegation_rejected" });
        else res.status(502).json({ error: "mcp_unavailable" });
      }
      return;
    }

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
    if (!config.agentDid || normalizeDid(identity.delegateDID) !== normalizeDid(config.agentDid)) {
      res.status(400).json({
        error: "wrong_delegatee",
        message: "Delegation delegatee must be the agent DID",
        expected: config.agentDid ?? null,
        actual: identity.delegateDID,
      });
      return;
    }

    if (isV2) {
      if (!signedOwnerMatches(session.delegations.memory, user.address)) {
        res.status(400).json({ error: "wrong_delegator" });
        return;
      }
      const transcript = validateSignedTranscript(session.delegations.transcripts, user.address, config.agentDid!);
      if (!transcript.ok) {
        res.status(400).json({ error: transcript.error });
        return;
      }
    }

    // Routing key the service registers and later routes on. Lowercase seed
    // (entity-id.ts) keeps checksummed and lowercase addresses aligned.
    const entityId = addressToEntityId(user.address, agentId);
    const revision = req.body?.revision;
    if (typeof revision !== "string" || !revision) {
      res.status(409).json({ error: "access_revision_required" });
      return;
    }
    if (!isV2) {
      res.status(409).json({ error: "bundle_required" });
      return;
    }
    invalidate(entityId);
    try {
      const eliza = await callEliza("POST", "/sessions", {
        agentId,
        entityId,
        revision,
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

  router.delete("/session", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (mcpWiring(user.address)) {
      // The MCP has no revoke route: its grant ends at expiry, or when the owner revokes it on the node.
      res.status(409).json({ error: "disconnect_unsupported" });
      return;
    }
    const entityId = addressToEntityId(user.address, agentId);
    invalidate(entityId);
    try {
      const eliza = await callEliza("DELETE", `/sessions/${encodeURIComponent(entityId)}`);
      if (eliza.status === 200 && (eliza.body.status !== "none" || eliza.body.state !== "disconnected" || typeof eliza.body.revision !== "string" || !eliza.body.revision)) {
        res.status(502).json({ error: "disconnect_unconfirmed" });
        return;
      }
      res.status(eliza.status).json(eliza.body);
    } catch {
      res.status(502).json({ error: "eliza_unreachable" });
    }
  });

  router.get("/session", async (req: Request, res: Response) => {
    const user = requireUser(req, res);
    if (!user) return;
    const mcp = mcpWiring(user.address);
    if (mcp) {
      try {
        const status = await mcp.mcpMeetings.status(mcp.mcpOwnerDidFor(user.address), AbortSignal.timeout(statusTimeoutMs));
        res.status(200).json({ ...status, mcp: { serviceDid: mcp.mcpGrants.serviceDid } });
      } catch {
        res.status(502).json({ error: "mcp_unavailable" });
      }
      return;
    }

    const entityId = addressToEntityId(user.address, agentId);
    try {
      const eliza = await callEliza("GET", `/sessions/${encodeURIComponent(entityId)}`, undefined, statusTimeoutMs);
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
function parseAttUri(uri: string): { owner: string; space: string; service: string; path: string } | null {
  const segments = uri.split("/");
  const space = segments[0] ?? "";
  const service = segments[1] ?? "";
  const owner = space.split(":")[4] ?? "";
  if (!service || !owner) return null;
  return { owner, space, service, path: segments.slice(2).join("/") };
}

function attGrants(att: Record<string, unknown>): Array<{ owner: string; space: string; service: string; path: string; actions: string[] }> | null {
  const grants: Array<{ owner: string; space: string; service: string; path: string; actions: string[] }> = [];
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
function cidBackedGrants(serialized: string): Array<{ owner: string; space: string; service: string; path: string; actions: string[] }> | null {
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

    const grants: Array<{ owner: string; space: string; service: string; path: string; actions: string[] }> = [];
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
        space: entry.space,
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
 * authenticated owner, configured agent, 30-day ceiling, and fixed
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

/**
 * The exact grant the MCP accepts (js-sdk packages/mcp native-auth): SQL read on the connectors db and KV get/list on its
 * prefix, both in the owner's `applications` space, delegated to the MCP service DID, at most 30 days. The MCP re-verifies
 * the signature and the node enforces it on use; this courier gate stops a wrong audience, owner, space or scope before
 * anything is forwarded.
 */
const MCP_GRANT_CEILING: Array<{ service: string; path: string; actions: Set<string> }> = [
  { service: "sql", path: TRANSCRIPT_SQL, actions: new Set(["tinycloud.sql/read"]) },
  { service: "kv", path: TRANSCRIPT_KV, actions: new Set(["tinycloud.kv/get", "tinycloud.kv/list"]) },
];
const MCP_OWNER_DID = /^did:pkh:eip155:([1-9][0-9]*):(0x[0-9a-fA-F]{40})$/;

export function validateSignedMcpGrant(serialized: string, ownerDid: string, serviceDid: string): { ok: true } | { ok: false; error: string } {
  let parsed: { delegateDID?: unknown; expiry?: unknown; chainId?: unknown };
  try {
    parsed = JSON.parse(serialized) as { delegateDID?: unknown; expiry?: unknown; chainId?: unknown };
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (typeof parsed.delegateDID !== "string" || parsed.delegateDID !== serviceDid) return { ok: false, error: "wrong_delegatee" };
  // The complete owner DID, chain included, is the authenticated session's; the grant's signed spaces and its chain must match it.
  const expectedOwner = MCP_OWNER_DID.exec(ownerDid);
  if (!expectedOwner || parsed.chainId !== Number(expectedOwner[1])) return { ok: false, error: "wrong_delegator" };
  const summaryExpiry = new Date(parsed.expiry as string);
  if (!Number.isFinite(summaryExpiry.getTime()) || summaryExpiry <= new Date()) return { ok: false, error: "delegation_expired" };
  const payload = signedPayload(serialized);
  const signedExpiryMs = payload?.exp === null || payload === null ? null : payload.exp * 1_000;
  if (signedExpiryMs !== null && signedExpiryMs <= Date.now()) return { ok: false, error: "delegation_expired" };
  const effectiveExpiryMs = signedExpiryMs === null ? summaryExpiry.getTime() : Math.max(summaryExpiry.getTime(), signedExpiryMs);
  if (effectiveExpiryMs - Date.now() > MAX_TRANSCRIPT_EXPIRY_MS) return { ok: false, error: "delegation_expiry_too_long" };

  // Exactly the two connector entries. Any other entry, including a capabilities entry, is refused: the MCP accepts exactly
  // these two effective permissions, and a real SDK delegation for them carries nothing else.
  const grants = payload ? attGrants(payload.att) : cidBackedGrants(serialized);
  if (!grants || grants.length !== MCP_GRANT_CEILING.length) return { ok: false, error: "mcp_grant_policy_exceeded" };
  const seen = new Set<string>();
  for (const grant of grants) {
    const expectedSpace = `tinycloud:pkh:eip155:${expectedOwner[1]}:${expectedOwner[2]}:applications`;
    if (grant.space.toLowerCase() !== expectedSpace.toLowerCase()) return { ok: false, error: "wrong_delegator" };
    const allowed = MCP_GRANT_CEILING.find((entry) => entry.service === grant.service && entry.path === grant.path);
    if (!allowed || seen.has(allowed.service)) return { ok: false, error: "mcp_grant_policy_exceeded" };
    if (grant.actions.length !== allowed.actions.size || grant.actions.some((action) => !allowed.actions.has(action))) {
      return { ok: false, error: "mcp_grant_policy_exceeded" };
    }
    seen.add(allowed.service);
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
