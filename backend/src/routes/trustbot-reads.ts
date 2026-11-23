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

import express, { Router, type Request, type RequestHandler } from "express";
import { NonceGuard, verifyCall } from "../bots-signed-call.js";
import { createMcpMeetingTools } from "../mcp-meetings/dispatch.js";
import { compactLegacyMeetingResult } from "../transcripts/legacy-meeting-projection.js";
import { parseMeetingToolData } from "../transcripts/meeting-evidence.js";
import { readAuditArea, TRUSTBOT_MEETING_TOOLS, type ReadAudit, type ReadOutcome } from "../trustbot-reads/audit.js";
import { isReadArea, READ_AREA_NAMES } from "../trustbot-reads/areas.js";
import { ReadGrantInvalid, ReadGrantRefused, type ReadStatus, type TrustBotReadGrants } from "../trustbot-reads/grants.js";
import { delegatedFeedChatSql, FEED_CHAT_FIRST_DATABASE, FeedChatReadError, isFeedChatTool, runFeedChatTool } from "../trustbot-reads/feed-chat.js";
import type { StandingReadControl } from "../trustbot-reads/standing.js";
import { delegatedMeetingPort } from "../trustbot-reads/meeting-port.js";
import { botOwnerDid, botsServiceHeaders, type BotsConfig } from "./bots.js";

export { TRUSTBOT_MEETING_TOOLS };
export const TRUSTBOT_READS_INTERNAL_PREFIX = "/api/internal/bots/main/reads";
/** The internal route's request body is `{ "args": {…} }`; meeting tool arguments are short. */
export const TRUSTBOT_READS_BODY_LIMIT = 16 * 1024;
/** Selection state for follow-ups ("read it") is kept per owner under this room; it holds a reference, never text. */
const TRUSTBOT_ROOM = "trustbot-main";
const MAX_REFUSAL_REPORTS_PER_OWNER_PER_DAY = 200;
/** Reader failures that mean the node refused the grant. */
const GRANT_ENDED = new Set(["delegation_expired"]);
const GRANT_REFUSED = new Set(["delegation_revoked", "delegation_required", "access_denied"]);

export interface TrustBotReadsOptions {
  grants: TrustBotReadGrants;
  config: BotsConfig;
  auth: RequestHandler;
  /** Shared with the bots service's gateway (BOTS_BACKEND_CALL_SECRET). */
  callSecret: string;
  audit?: ReadAudit;
  standing?: StandingReadControl;
  standingEnabled?: boolean;
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

const DAY_MS = 86_400_000;

/** Accept UTC timestamps and reject impossible dates before normalizing them for the audit store. */
function summaryTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19) ? ms : NaN;
}

export function createTrustBotReadsRouter(
  { grants, config, auth, standingEnabled, standing: control, audit }:
    Pick<TrustBotReadsOptions, "grants" | "config" | "auth" | "standingEnabled" | "standing" | "audit">,
) {
  const standing = standingEnabled ? control : undefined;
  const router = Router();
  router.use(auth);
  router.use((req, res, next) => {
    if (!req.user || !config.accountAllowed(req.user.address)) { res.status(404).end(); return; }
    next();
  });
  const readView = (status: ReadStatus) => ({
    ...view(grants, status), ...(standing ? { standingAvailable: true } : {}),
  });
  router.get("/", async (req, res) => {
    try {
      const status = await grants.status(req.user!.address);
      // The service's copy of the setting goes with the bot's working state; it is given again whenever the owner looks.
      if (READ_AREA_NAMES.some(area => status.areas[area] === "on")) void pushToService(config, req.user!.address, status);
      res.json(readView(status));
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
  if (standingEnabled && audit) {
    router.get("/standing/summary", async (req, res) => {
      res.set("Cache-Control", "no-store");
      const to = req.query.to === undefined ? Date.now() : summaryTime(req.query.to);
      const from = req.query.from === undefined ? to - 7 * DAY_MS : summaryTime(req.query.from);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 90 * DAY_MS) {
        res.status(400).json({ error: "invalid_range" });
        return;
      }
      try {
        res.json(await audit.summary(botOwnerDid(req.user!.address), new Date(from).toISOString(), new Date(to).toISOString()));
      } catch {
        res.status(503).json({ error: "reads_unavailable" });
      }
    });
  }
  if (standing) {
    const currentAreas = async (owner: string) => {
      const status = await grants.status(owner);
      return READ_AREA_NAMES.filter(area => status.areas[area] !== "off");
    };
    router.get("/standing", async (req, res) => {
      const owner = req.user!.address;
      try { res.json(await standing.view(owner, await currentAreas(owner))); }
      catch { res.status(503).json({ error: "reads_unavailable" }); }
    });
    router.post("/standing", async (req, res) => {
      const owner = req.user!.address;
      try {
        const areas = await currentAreas(owner);
        if (areas.length === 0) { res.status(409).json({ error: "no_read_areas" }); return; }
        res.json(await standing.request(owner, areas));
      } catch { res.status(503).json({ error: "reads_unavailable" }); }
    });
    router.delete("/standing/:cid", async (req, res) => {
      if (!/^[a-z0-9]{20,120}$/.test(req.params.cid)) { res.status(400).json({ error: "invalid_grant" }); return; }
      try {
        await standing.finishStop(req.user!.address, req.params.cid);
        res.status(204).end();
      } catch { res.status(503).json({ error: "reads_unavailable" }); }
    });
  }
  router.put("/:area", express.json({ limit: "96kb" }), async (req, res) => {
    const area = req.params.area;
    const renewing = area === "renewal";
    const input: unknown = req.body;
    if ((!renewing && !isReadArea(area)) || !input || typeof input !== "object" || Array.isArray(input)) { res.status(400).json({ error: "invalid_reads" }); return; }
    const { enabled, grant, replaces } = input as { enabled?: unknown; grant?: unknown; replaces?: unknown };
    const address = req.user!.address;
    try {
      let status: ReadStatus;
      if (enabled === false && isReadArea(area)) {
        await standing?.beforeAreaOff(address, area);
        status = await grants.disable(address, area);
      }
      else if (enabled === true && grant && typeof grant === "object") {
        const { serialized, siwe, signature } = grant as Record<string, unknown>;
        if (typeof serialized !== "string" || typeof siwe !== "string" || typeof signature !== "string") { res.status(400).json({ error: "invalid_reads" }); return; }
        const envelope = { serialized, siwe, signature };
        if (renewing && typeof replaces === "string") status = await grants.renew(address, replaces, envelope);
        else if (isReadArea(area)) status = await grants.enable(address, area, envelope);
        else { res.status(400).json({ error: "invalid_reads" }); return; }
      } else { res.status(400).json({ error: "invalid_reads" }); return; }
      if (!await pushToService(config, address, status)) console.warn("[trustbot-reads] service_push=failed");
      res.json(readView(status));
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

function grantAuditOutcome(error: unknown): ReadOutcome {
  if (!(error instanceof ReadGrantRefused)) return "error";
  const policy = "auditOutcome" in error ? error.auditOutcome : undefined;
  if (policy === "not_owner" || policy === "no_grant" || policy === "expired" || policy === "revoked" || policy === "unavailable") return policy;
  switch (error.code) {
    case "none": return "no_grant";
    case "off": return "off";
    case "ended": return "expired";
    case "rejected": return "unavailable";
    case "unavailable": return "unavailable";
  }
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

export function createTrustBotReadsInternalRouter(
  { grants, config, callSecret, audit }: Pick<TrustBotReadsOptions, "grants" | "config" | "callSecret" | "audit">,
) {
  const router = Router();
  const nonces = new NonceGuard();
  // Only Main can report refusals, so the signed owner is also the bot's budget key.
  const refusalReports = new Map<string, number>();
  let refusalDay = "";
  const bytesOf = (req: Request): Buffer => Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const verify = (req: Request) => verifyCall(req.headers.authorization, { method: req.method, path: req.originalUrl, body: bytesOf(req) }, {
    secret: callSecret, direction: "to-backend", environment: config.environment ?? "private", nonces,
  });

  router.post("/audit/refusal", express.raw({ type: () => true, limit: "1kb" }), async (req, res) => {
    const claims = verify(req);
    if (!claims || claims.bot !== "main") { res.status(401).end(); return; }
    let report: unknown;
    try { report = JSON.parse(bytesOf(req).toString("utf8")); } catch { /* Invalid report. */ }
    if (!report || typeof report !== "object" || Object.keys(report).length !== 4) { res.status(400).end(); return; }
    const { owner, area, tool, outcome } = report as Record<string, unknown>;
    const expectedArea = typeof tool === "string" ? readAuditArea(tool) : undefined;
    if (!expectedArea || area !== expectedArea || owner !== claims.owner || typeof tool !== "string" ||
      (outcome !== "off" && outcome !== "budget" && outcome !== "busy" && outcome !== "unavailable")) {
      res.status(400).end();
      return;
    }
    const allowed = config.accountAllowed(claims.owner.slice(claims.owner.lastIndexOf(":") + 1));
    try {
      if (audit) {
        const at = new Date().toISOString();
        const day = at.slice(0, 10);
        if (day !== refusalDay) {
          refusalReports.clear();
          refusalDay = day;
        }
        const reports = refusalReports.get(claims.owner) ?? 0;
        if (reports >= MAX_REFUSAL_REPORTS_PER_OWNER_PER_DAY) { res.status(429).end(); return; }
        refusalReports.set(claims.owner, reports + 1);
        const id = await audit.begin({ at, owner: claims.owner, area: expectedArea, tool });
        await audit.settle(id, allowed ? outcome : "not_owner");
      }
      res.status(allowed ? 204 : 404).end();
    } catch {
      res.status(503).end();
    }
  });
  // Every read goes through the owner's grant, checked again by grants.access; nothing about it is kept here.
  const tools = createMcpMeetingTools(owner =>
    delegatedMeetingPort(() => grants.access(owner.slice(owner.lastIndexOf(":") + 1), "meetings")));
  router.post("/:tool", express.raw({ type: () => true, limit: TRUSTBOT_READS_BODY_LIMIT }), async (req, res) => {
    const claims = verify(req);
    if (!claims || claims.bot !== "main") { res.status(401).end(); return; }
    const address = claims.owner.slice(claims.owner.lastIndexOf(":") + 1);
    const tool = req.params.tool;
    const area = readAuditArea(tool);
    if (!area) { res.status(404).end(); return; }
    let id: string | undefined;
    try {
      id = await audit?.begin({ at: new Date().toISOString(), owner: claims.owner, area, tool });
    } catch {
      res.status(200).json({ ok: false, error: "unavailable" });
      return;
    }
    const settle = async (outcome: ReadOutcome) => {
      if (id !== undefined) await audit!.settle(id, outcome);
    };
    const answer = async (status: number, body: ToolAnswer, outcome: ReadOutcome) => {
      try { await settle(outcome); }
      catch { res.status(200).json({ ok: false, error: "unavailable" }); return; }
      res.status(status).json(body);
    };
    if (!config.accountAllowed(address)) {
      await settle("not_owner").catch(() => {});
      res.status(404).end();
      return;
    }
    const feedChat = isFeedChatTool(tool) ? tool : undefined;
    let args: unknown;
    try { args = (JSON.parse(bytesOf(req).toString("utf8")) as { args?: unknown }).args; } catch { args = undefined; }
    if (!args || typeof args !== "object" || Array.isArray(args)) { await answer(400, { ok: false, error: "invalid" }, "error"); return; }
    // Checked before the tool runs, so a refusal answers with the owner's setting rather than a failed read.
    try {
      if (feedChat) await grants.access(address, "feed_chats", FEED_CHAT_FIRST_DATABASE[feedChat]);
      else await grants.access(address, "meetings");
    } catch (error) {
      await answer(200, refusal(error), grantAuditOutcome(error));
      return;
    }
    if (feedChat) {
      // Each query activates only the resource its database sits under (feed-chat.ts feedChatResource).
      try {
        const sql = delegatedFeedChatSql(resource => grants.access(address, "feed_chats", resource));
        await answer(200, { ok: true, text: await runFeedChatTool(feedChat, args as Record<string, unknown>, sql) }, "ok");
      } catch (error) {
        if (error instanceof ReadGrantRefused) { await answer(200, refusal(error), grantAuditOutcome(error)); return; }
        if (!(error instanceof FeedChatReadError)) { await answer(200, { ok: false, error: "unavailable" }, "error"); return; }
        if (error.code === "rejected") {
          grants.forgetActivation(address);
          await answer(200, { ok: false, error: "unavailable" }, "unavailable");
          return;
        }
        await answer(200, { ok: false, error: error.code === "not_found" ? "not_found" : "invalid", code: error.code }, error.code === "not_found" ? "not_found" : "error");
      }
      return;
    }
    const owner = claims.owner;
    try {
      const result = await tools.run({ name: tool, args: args as Record<string, unknown>, owner, roomId: TRUSTBOT_ROOM });
      const body = result.body as { result?: { text?: unknown; data?: unknown }; error?: unknown; code?: unknown };
      if (result.status === 200 && body.result) { await answer(200, { ok: true, text: toolText(body.result) }, "ok"); return; }
      const code = typeof body.error === "string" ? body.error : typeof body.code === "string" ? body.code : "tool_failed";
      if (GRANT_ENDED.has(code) || GRANT_REFUSED.has(code)) {
        grants.forgetActivation(address);
        await answer(200, { ok: false, error: GRANT_ENDED.has(code) ? "ended" : "unavailable" },
          code === "delegation_expired" ? "expired" : code === "delegation_revoked" ? "revoked" :
          code === "delegation_required" ? "no_grant" : "unavailable");
        return;
      }
      await answer(200, { ok: false, error: result.status >= 500 ? "unavailable" : "invalid", code: /^[a-z0-9_]{1,64}$/.test(code) ? code : "tool_failed" },
        result.status === 404 ? "not_found" : code === "mcp_unavailable" ? "unavailable" : "error");
    } catch {
      await answer(200, { ok: false, error: "unavailable" }, "error");
    }
  });
  return router;
}
