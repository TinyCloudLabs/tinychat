// TrustBot's reads of the owner's data (TC-3792, TC-3794).
//
// Owner routes, under /api/bots/main/reads: the state of each area and turning one on (with a grant the owner signed in
// the browser) or off. The owner is always the authenticated session address.
//
// Internal route, POST /api/internal/bots/main/reads/<tool>: the bots gateway runs one read tool for Main. It is a
// signed call (bots-signed-call.ts, `to-backend`) whose claims name the owner; the body is `{ "args": {…} }`. Only the
// four meeting tools and the four feed and chat tools are served, and each read uses the owner's grant to TrustBot's
// read identity, checked again here.
// Details: TC-3792, TC-3794

import express, { Router, type RequestHandler } from "express";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { createMcpMeetingTools } from "../mcp-meetings/dispatch.js";
import { TINYCLOUD_FIND_MEETINGS, TINYCLOUD_LIST_MEETING_ACTIONS, TINYCLOUD_READ_MEETING, TINYCLOUD_SEARCH_TRANSCRIPTS } from "../mcp-meetings/tools.js";
import { compactLegacyMeetingResult } from "../transcripts/legacy-meeting-projection.js";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";
import { isReadArea, READ_AREA_NAMES } from "../trustbot-reads/areas.js";
import { ReadGrantInvalid, ReadGrantRefused, type ReadStatus, type TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { delegatedFeedChatSql, FEED_CHAT_FIRST_DATABASE, FeedChatReadError, isFeedChatTool, runFeedChatTool } from "../trustbot-reads/feed-chat.js";
import { delegatedMeetingPort } from "../trustbot-reads/meeting-port.js";
import { botOwnerDid, botsServiceHeaders, type BotsConfig } from "./bots.js";

/** The meeting tools TrustBot may run, by the names the gateway serves them under. */
export const TRUSTBOT_MEETING_TOOLS = [
  TINYCLOUD_FIND_MEETINGS, TINYCLOUD_READ_MEETING, TINYCLOUD_SEARCH_TRANSCRIPTS, TINYCLOUD_LIST_MEETING_ACTIONS,
] as const;
export const TRUSTBOT_READS_INTERNAL_PREFIX = "/api/internal/bots/main/reads";
/** The internal route's request body is `{ "args": {…} }`; meeting tool arguments are short. */
export const TRUSTBOT_READS_BODY_LIMIT = 16 * 1024;
/** Selection state for follow-ups ("read it") is kept per owner under this room; it holds a reference, never text. */
const TRUSTBOT_ROOM = "trustbot-main";
/** Reader failures that mean the node refused the grant. */
const GRANT_ENDED = new Set(["delegation_expired"]);
const GRANT_REFUSED = new Set(["delegation_revoked", "delegation_required", "access_denied"]);

export interface TrustBotReadsOptions {
  grants: TrustBotReadGrants;
  config: BotsConfig;
  auth: RequestHandler;
  /** Shared with the bots service's gateway (BOTS_BACKEND_CALL_SECRET). */
  callSecret: string;
}

/** Tells the bots service which areas are on, so the gateway offers those tools. False when it did not answer. */
async function pushToService(config: BotsConfig, address: string, status: ReadStatus): Promise<boolean> {
  const url = `${config.serviceUrl}/v1/bots/main/reads`;
  const body = JSON.stringify({ areas: READ_AREA_NAMES.filter(area => status.areas[area] === "on") });
  try {
    const response = await (config.fetchImpl ?? fetch)(url, {
      method: "PUT", headers: botsServiceHeaders(config, botOwnerDid(address), "PUT", url, body), body, signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const view = (grants: TrustBotReadGrants, status: ReadStatus) => ({ serviceDid: grants.serviceDid, ...status });

export function createTrustBotReadsRouter({ grants, config, auth }: Pick<TrustBotReadsOptions, "grants" | "config" | "auth">) {
  const router = Router();
  router.use(auth);
  router.use((req, res, next) => {
    if (!req.user || !config.accountAllowed(req.user.address)) { res.status(404).end(); return; }
    next();
  });
  router.get("/", async (req, res) => {
    try {
      const status = await grants.status(req.user!.address);
      // The service's copy of the setting goes with the bot's working state; it is given again whenever the owner looks.
      if (READ_AREA_NAMES.some(area => status.areas[area] === "on")) void pushToService(config, req.user!.address, status);
      res.json(view(grants, status));
    } catch {
      res.status(503).json({ error: "reads_unavailable" });
    }
  });
  router.get("/renewal", async (req, res) => {
    try {
      res.json({ serviceDid: grants.serviceDid, ...await grants.renewalStatus(req.user!.address) });
    } catch {
      res.status(503).json({ error: "reads_unavailable" });
    }
  });
  // The owner's browser calls this after the node confirms the revoke of the grant a renewal replaced.
  router.delete("/renewal", async (req, res) => {
    const replaced = req.query.replaced;
    if (typeof replaced !== "string") { res.status(400).json({ error: "invalid_reads" }); return; }
    try {
      await grants.clearReplaced(req.user!.address, replaced);
      res.status(204).end();
    } catch (error) {
      if (error instanceof ReadGrantInvalid) { res.status(400).json({ error: "invalid_grant", code: error.code }); return; }
      res.status(503).json({ error: "reads_unavailable" });
    }
  });
  router.put("/:area", express.json({ limit: "96kb" }), async (req, res) => {
    const area = req.params.area;
    const renewing = area === "renewal";
    const input: unknown = req.body;
    if ((!renewing && !isReadArea(area)) || !input || typeof input !== "object" || Array.isArray(input)) { res.status(400).json({ error: "invalid_reads" }); return; }
    const { enabled, grant, replaces } = input as { enabled?: unknown; grant?: unknown; replaces?: unknown };
    const address = req.user!.address;
    try {
      let status: ReadStatus;
      if (enabled === false && isReadArea(area)) status = await grants.disable(address, area);
      else if (enabled === true && grant && typeof grant === "object") {
        const { serialized, siwe, signature } = grant as Record<string, unknown>;
        if (typeof serialized !== "string" || typeof siwe !== "string" || typeof signature !== "string") { res.status(400).json({ error: "invalid_reads" }); return; }
        const envelope = { serialized, siwe, signature };
        if (renewing && typeof replaces === "string") status = await grants.renew(address, replaces, envelope);
        else if (isReadArea(area)) status = await grants.enable(address, area, envelope);
        else { res.status(400).json({ error: "invalid_reads" }); return; }
      } else { res.status(400).json({ error: "invalid_reads" }); return; }
      if (!await pushToService(config, address, status)) console.warn("[trustbot-reads] service_push=failed");
      res.json(view(grants, status));
    } catch (error) {
      if (error instanceof ReadGrantInvalid) { res.status(400).json({ error: "invalid_grant", code: error.code }); return; }
      res.status(503).json({ error: "reads_unavailable" });
    }
  });
  return router;
}

type ToolAnswer = { ok: true; text: string } | { ok: false; error: "off" | "ended" | "unavailable" | "invalid" | "not_found"; code?: string };

/** A refused grant as the gateway reports it: the owner's setting, an ended grant, or the service being down. */
function refusal(error: unknown): ToolAnswer {
  const code = error instanceof ReadGrantRefused ? error.code : "unavailable";
  return { ok: false, error: code === "none" || code === "off" ? "off" : code === "ended" || code === "rejected" ? "ended" : "unavailable" };
}

/** The text the model reads: the summary and one cited projection of the result, as meeting chat gives it. */
function toolText(result: { text?: unknown; data?: unknown }): string {
  const summary = typeof result.text === "string" ? result.text : "";
  const raw = result.data && typeof result.data === "object" && !Array.isArray(result.data) ? result.data as Record<string, unknown> : undefined;
  const typed = parseMeetingToolData(raw);
  const compact = raw && typed ? compactLegacyMeetingResult(raw, typed) : null;
  if (compact) return compact;
  const data = raw ? JSON.stringify(raw) : "";
  return summary && data ? `${summary}\n\nTool data:\n${data}` : summary || data;
}

export function createTrustBotReadsInternalRouter({ grants, config, callSecret }: Pick<TrustBotReadsOptions, "grants" | "config" | "callSecret">) {
  const router = Router();
  const nonces = new NonceGuard();
  // Every read goes through the owner's grant, checked again by grants.access; nothing about it is kept here.
  const tools = createMcpMeetingTools(owner =>
    delegatedMeetingPort(() => grants.access(owner.slice(owner.lastIndexOf(":") + 1), "meetings")));
  router.post("/:tool", express.raw({ type: () => true, limit: TRUSTBOT_READS_BODY_LIMIT }), async (req, res) => {
    const answer = (status: number, body: ToolAnswer) => res.status(status).json(body);
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const claims = verifyCall(req.headers.authorization, { method: req.method, path: req.originalUrl, body: bytes }, {
      secret: callSecret, direction: "to-backend", environment: config.environment ?? "private", nonces,
    });
    if (!claims || claims.bot !== "main") { res.status(401).end(); return; }
    const address = claims.owner.slice(claims.owner.lastIndexOf(":") + 1);
    if (!config.accountAllowed(address)) { res.status(404).end(); return; }
    const feedChat = isFeedChatTool(req.params.tool) ? req.params.tool : undefined;
    const tool = feedChat ?? TRUSTBOT_MEETING_TOOLS.find(name => name === req.params.tool);
    if (!tool) { res.status(404).end(); return; }
    let args: unknown;
    try { args = (JSON.parse(bytes.toString("utf8")) as { args?: unknown }).args; } catch { args = undefined; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { answer(400, { ok: false, error: "invalid" }); return; }
    // Checked before the tool runs, so a refusal answers with the owner's setting rather than a failed read.
    try {
      if (feedChat) await grants.access(address, "feed_chats", FEED_CHAT_FIRST_DATABASE[feedChat]);
      else await grants.access(address, "meetings");
    } catch (error) {
      answer(200, refusal(error));
      return;
    }
    if (feedChat) {
      // Each query activates only the resource its database sits under (feed-chat.ts feedChatResource).
      try {
        const sql = delegatedFeedChatSql(resource => grants.access(address, "feed_chats", resource));
        answer(200, { ok: true, text: await runFeedChatTool(feedChat, args as Record<string, unknown>, sql) });
      } catch (error) {
        if (error instanceof ReadGrantRefused) { answer(200, refusal(error)); return; }
        if (!(error instanceof FeedChatReadError)) { answer(200, { ok: false, error: "unavailable" }); return; }
        if (error.code === "rejected") {
          grants.forgetActivation(address);
          answer(200, { ok: false, error: "unavailable" });
          return;
        }
        answer(200, { ok: false, error: error.code === "not_found" ? "not_found" : "invalid", code: error.code });
      }
      return;
    }
    const owner = claims.owner;
    try {
      const result = await tools.run({ name: tool, args: args as Record<string, unknown>, owner, roomId: TRUSTBOT_ROOM });
      const body = result.body as { result?: { text?: unknown; data?: unknown }; error?: unknown; code?: unknown };
      if (result.status === 200 && body.result) { answer(200, { ok: true, text: toolText(body.result) }); return; }
      const code = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : "tool_failed";
      if (GRANT_ENDED.has(code) || GRANT_REFUSED.has(code)) {
        grants.forgetActivation(address);
        answer(200, { ok: false, error: GRANT_ENDED.has(code) ? "ended" : "unavailable" });
        return;
      }
      answer(200, { ok: false, error: result.status >= 500 ? "unavailable" : "invalid", code: /^[a-z0-9_]{1,64}$/.test(code) ? code : "tool_failed" });
    } catch {
      answer(200, { ok: false, error: "unavailable" });
    }
  });
  return router;
}
