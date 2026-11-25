// /api/bots — tiny bots slice 1 (TC-2808): the owner's Main bot, proxied to the bots service.
//
// The owner is always the authenticated session address; the body and request headers never choose it.
// Each call to the service is signed (bots-signed-call.ts). Message content is neither logged nor stored here.

import { botsConnectFetch, validateBotsConnectHost } from "../bots-transport";
import { type Environment, signedCallHeader } from "../bots-signed-call";
import { Router } from "express";
import type { Request, RequestHandler, Response } from "express";
import { botCaps, CAP_MODE, type CapMode, type PlanName } from "../bot-caps";
import { isBotActivityRecord } from "../bot-history.js";
import { BOT_KEY, MAIN_BOT_KEY, MAIN_BOT_NAME, orderedBots, publicBot, publicDeleted, type Bot, type BotsRegistry } from "../bots-registry";
import { clientContextFrom } from "../client-context";

export interface BotsConfig {
  serviceUrl: string;
  serviceSecret: string;
  /** The environment of the service at serviceUrl, signed into every call. Default `private`. */
  environment?: Environment;
  accountAllowed: (address: string) => boolean;
  /** Overall bound on one POST turn (BOTS_POST_TIMEOUT_MS, default 120000). */
  postTimeoutMs: number;
  fetchImpl?: typeof fetch;
  onTurnFinished?: () => void;
  /** Current owner-scoped admission for an outgoing turn, supplied by the registry. */
  listForTurn?: (ownerDid: string, sourceKey: string) => Promise<string[]>;
  /** The name the owner sees for the bot a turn goes to, supplied by the registry; it only words the bot's prompt. */
  nameForTurn?: (ownerDid: string, key: string) => Promise<string | undefined>;
}

// Legacy history may restore a sandbox before OMP can answer. Keep this GET bounded independently of turns.
export const BOTS_HISTORY_GET_TIMEOUT_MS = 300_000;
const MAX_TEXT = 8000;
const UNAVAILABLE = { code: "bot_unavailable", message: `${MAIN_BOT_NAME} isn't available. Try again later.` };

/** Same canonical owner DID as MCP chat: did:pkh on chain 1 with the lowercased address. */
export function botOwnerDid(address: string): string {
  return `did:pkh:eip155:1:${address.toLowerCase()}`;
}

const WEB_MODES = ["off", "listed", "any"] as const;
type WebMode = (typeof WEB_MODES)[number];
const MAX_WEB_HOSTS = 50;
const MAX_WEB_HOST_LENGTH = 253;
const MAX_WEB_MESSAGE = 200;
const WEB_INVALID_MESSAGE = "Those sites weren't accepted. Use site names like example.com, one per line, up to 50. Shared domains like github.io or co.uk need your own name in front, like you.github.io.";

const isWebMode = (value: unknown): value is WebMode => WEB_MODES.some(mode => mode === value);

/** The only two fields a browser may set; anything else in the body is dropped. */
function webSettingsBody(body: unknown): { mode: WebMode; hosts: string[] } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { mode, hosts } = body as { mode?: unknown; hosts?: unknown };
  if (!isWebMode(mode) || !Array.isArray(hosts) || hosts.length > MAX_WEB_HOSTS) return null;
  if (!hosts.every(host => typeof host === "string" && host.length <= MAX_WEB_HOST_LENGTH)) return null;
  return { mode, hosts: hosts as string[] };
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/** Rebuilds the service's answer from the contract fields; null when it does not have the contract's shape. */
function toWebSettings(payload: unknown): { mode: WebMode; hosts: string[]; available: boolean; today: { searches: number; pages: number; blocked: number } } | null {
  if (!payload || typeof payload !== "object") return null;
  const { mode, hosts, available, today } = payload as { mode?: unknown; hosts?: unknown; available?: unknown; today?: unknown };
  if (!isWebMode(mode) || !Array.isArray(hosts) || !hosts.every(host => typeof host === "string") || typeof available !== "boolean") return null;
  if (!today || typeof today !== "object") return null;
  const { searches, pages, blocked } = today as { searches?: unknown; pages?: unknown; blocked?: unknown };
  if (!isCount(searches) || !isCount(pages) || !isCount(blocked)) return null;
  return { mode, hosts: [...hosts], available, today: { searches, pages, blocked } };
}

const ASK_REQUEST_ID = /^[0-9a-f]{1,64}$/;
const MAX_ASK_ANSWER = 280;
const MAX_ASK_CHOICES = 4;
const MAX_LISTED_REQUESTS = 50;
const ASK_STATES = ["pending", "answered", "declined", "stopped", "expired"] as const;
type AskState = (typeof ASK_STATES)[number];
const SECRET_STATES = ["pending", "approved", "declined", "stopped", "revoked", "expired", "ended", "failed"] as const;
type SecretState = (typeof SECRET_STATES)[number];
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRET_SITES = 3;
const MAX_SECRET_WHY = 200;
/** The only page a secret request's approval may open. */
const OPENKEY_APPROVE = "https://openkey.so/";

/** Which decision to tell Main about. The only thing a browser names for an app-originated message. */
export interface AppReply {
  requestId: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function appReplyBody(value: unknown): AppReply | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return null;
  return typeof value.requestId === "string" && ASK_REQUEST_ID.test(value.requestId) ? { requestId: value.requestId } : null;
}

/** `{ enabled }` and nothing else. */
function asksSettingsBody(body: unknown): { enabled: boolean } | null {
  return isPlainObject(body) && Object.keys(body).length === 1 && typeof body.enabled === "boolean" ? { enabled: body.enabled } : null;
}

type AskAnswerBody = { decision: "decline" | "stop" | "retry" } | { decision: "answer"; answer: string } | { decision: "answer"; choice: number } | { decision: "approve"; binding: string };

const ACTION_BINDING = /^[0-9a-f]{64}$/;

/**
 * A decline, stop (an approved secret request) or retry (a failed one), an answer given as text (1 to 280 characters)
 * or as the index of one of the choices, or the owner's Send on a proposal card naming the binding the card showed;
 * nothing else is taken. The service checks which fits the request.
 */
function askAnswerBody(body: unknown): AskAnswerBody | null {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (body.decision === "decline" || body.decision === "stop" || body.decision === "retry") return keys.length === 1 ? { decision: body.decision } : null;
  if (body.decision === "approve") return keys.length === 2 && typeof body.binding === "string" && ACTION_BINDING.test(body.binding) ? { decision: "approve", binding: body.binding } : null;
  if (body.decision !== "answer" || keys.length !== 2) return null;
  if (typeof body.answer === "string") return body.answer.length >= 1 && body.answer.length <= MAX_ASK_ANSWER * 2 ? { decision: "answer", answer: body.answer } : null;
  return typeof body.choice === "number" && Number.isInteger(body.choice) && body.choice >= 0 && body.choice < MAX_ASK_CHOICES ? { decision: "answer", choice: body.choice } : null;
}

function toAsksSettings(payload: unknown): { enabled: boolean } | null {
  return isPlainObject(payload) && typeof payload.enabled === "boolean" ? { enabled: payload.enabled } : null;
}

interface QuestionRequestView {
  id: string;
  kind: "ask";
  state: AskState;
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  question?: string;
  choices?: string[];
  answer?: string;
  undelivered?: true;
}

/** A secret request: a name, sites and what was decided; never a value. */
interface SecretRequestView {
  id: string;
  kind: "secret";
  state: SecretState;
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  name: string;
  sites: string[];
  service?: string;
  why?: string;
  approveUrl?: string;
  until?: string;
  undelivered?: true;
}

type AskRequestView = QuestionRequestView | SecretRequestView;

const shortText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

/** A site the service named for a secret: a lowercase host name, nothing a browser could take for an address with a path. */
const isSiteName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(value);

function toSecretRequest(value: Record<string, unknown>, common: Omit<SecretRequestView, "kind" | "state" | "name" | "sites">): SecretRequestView | null {
  const { state, name, sites, service, why, approveUrl, until } = value;
  if (!SECRET_STATES.some(known => known === state) || typeof name !== "string" || !SECRET_NAME.test(name)) return null;
  if (!Array.isArray(sites) || sites.length < 1 || sites.length > MAX_SECRET_SITES || !sites.every(isSiteName)) return null;
  if (service !== undefined && !shortText(service, 60)) return null;
  if (why !== undefined && !shortText(why, MAX_SECRET_WHY * 2)) return null;
  if (approveUrl !== undefined && (!shortText(approveUrl, 2048) || !approveUrl.startsWith(OPENKEY_APPROVE))) return null;
  if (until !== undefined && (!shortText(until, 40) || Number.isNaN(Date.parse(until)))) return null;
  return {
    ...common, kind: "secret", state: state as SecretState, name, sites: [...sites as string[]],
    ...(service !== undefined ? { service } : {}),
    ...(why !== undefined ? { why } : {}),
    ...(approveUrl !== undefined ? { approveUrl } : {}),
    ...(until !== undefined ? { until } : {}),
  };
}

/** Rebuilds one request from the contract fields; null when the service's answer does not have the contract's shape. */
function toAskRequest(value: unknown): AskRequestView | null {
  if (!isPlainObject(value)) return null;
  const { id, kind, state, askedAt, expiresAt, outside, resolvedAt, question, choices, answer, undelivered } = value;
  if (typeof id !== "string" || !ASK_REQUEST_ID.test(id)) return null;
  if (!shortText(askedAt, 40) || !shortText(expiresAt, 40) || typeof outside !== "boolean") return null;
  if (resolvedAt !== undefined && !shortText(resolvedAt, 40)) return null;
  if (undelivered !== undefined && undelivered !== true) return null;
  const common = {
    id, askedAt, expiresAt, outside,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(undelivered ? { undelivered: true as const } : {}),
  };
  if (kind === "secret") return toSecretRequest(value, common);
  if (kind !== "ask" || !ASK_STATES.some(known => known === state)) return null;
  if (question !== undefined && !shortText(question, MAX_ASK_ANSWER * 2)) return null;
  if (answer !== undefined && !shortText(answer, MAX_ASK_ANSWER * 2)) return null;
  if (choices !== undefined && (!Array.isArray(choices) || choices.length > MAX_ASK_CHOICES || !choices.every(choice => shortText(choice, 120)))) return null;
  return {
    id, kind: "ask", state: state as AskState, askedAt, expiresAt, outside,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(question !== undefined ? { question } : {}),
    ...(choices !== undefined ? { choices: [...(choices as string[])] } : {}),
    ...(answer !== undefined ? { answer } : {}),
    ...(undelivered ? { undelivered: true as const } : {}),
  };
}

const ACTION_STATES = ["pending", "sending", "done", "declined", "expired", "stopped"] as const;
const MAX_ACTION_TARGETS = 8;
const MAX_ACTION_TEXT = 2000;

/** A proposal from Main for the owner's card. `targets` carries each recipient's current name, null when it is gone. */
interface ActionRequestView {
  id: string;
  kind: "action";
  action: "message_bots";
  state: (typeof ACTION_STATES)[number];
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  targets: { key: string; name: string | null }[];
  text?: string;
  binding?: string;
  outcomes?: { key: string; delivered: boolean }[];
  undelivered?: true;
}

/** Rebuilds one proposal from the contract fields, with recipients' names from `names`; null when the shape is wrong. */
function toActionRequest(value: Record<string, unknown>, names: ReadonlyMap<string, string>): ActionRequestView | null {
  const { id, action, state, askedAt, expiresAt, outside, resolvedAt, targets, text, binding, outcomes, undelivered } = value;
  if (typeof id !== "string" || !ASK_REQUEST_ID.test(id) || action !== "message_bots" || !ACTION_STATES.some(known => known === state)) return null;
  if (!shortText(askedAt, 40) || !shortText(expiresAt, 40) || typeof outside !== "boolean") return null;
  if (resolvedAt !== undefined && !shortText(resolvedAt, 40)) return null;
  if (!Array.isArray(targets) || targets.length > MAX_ACTION_TARGETS || !targets.every(key => typeof key === "string" && BOT_KEY.test(key))) return null;
  if (text !== undefined && !shortText(text, MAX_ACTION_TEXT * 2)) return null;
  if (binding !== undefined && (typeof binding !== "string" || !ACTION_BINDING.test(binding))) return null;
  if (undelivered !== undefined && undelivered !== true) return null;
  if (outcomes !== undefined && (!Array.isArray(outcomes) || outcomes.length > MAX_ACTION_TARGETS
    || !outcomes.every(outcome => isPlainObject(outcome) && typeof outcome.key === "string" && BOT_KEY.test(outcome.key) && typeof outcome.delivered === "boolean"))) return null;
  return {
    id, kind: "action", action: "message_bots", state: state as ActionRequestView["state"], askedAt, expiresAt, outside,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    targets: (targets as string[]).map(key => ({ key, name: names.get(key) ?? null })),
    ...(text !== undefined ? { text } : {}),
    ...(binding !== undefined ? { binding } : {}),
    ...(outcomes !== undefined ? { outcomes: (outcomes as { key: string; delivered: boolean }[]).map(({ key, delivered }) => ({ key, delivered })) } : {}),
    ...(undelivered ? { undelivered: true as const } : {}),
  };
}

const FEEDBACK_TYPES = ["bug", "friction", "improvement"] as const;
const FEEDBACK_OUTCOMES = ["filed", "rate_limited", "busy", "rejected", "unknown", "refused"] as const;
const FEEDBACK_AGENT = `TinyCloud One bot (${MAIN_BOT_NAME})`;
const FEEDBACK_REPORT_KEYS = ["area", "kind", "title", "tried", "happened", "expected", "agent"] as const;
const MAX_FEEDBACK_TITLE = 120;
const MAX_FEEDBACK_FIELD = 800;
const MAX_FEEDBACK_BYTES = 8 * 1024;
/** The feedback service's report id: a ULID. */
const FEEDBACK_REPORT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A feedback report from Main, exactly as the service gets it. */
interface FeedbackReportView {
  area: "other";
  kind: (typeof FEEDBACK_TYPES)[number];
  title: string;
  tried: string;
  happened: string;
  expected: string;
  agent: string;
}

/** A feedback proposal from Main for the owner's card: the report while pending, the send outcome once done. */
interface FeedbackRequestView {
  id: string;
  kind: "action";
  action: "send_feedback";
  state: (typeof ACTION_STATES)[number];
  askedAt: string;
  expiresAt: string;
  outside: boolean;
  resolvedAt?: string;
  report?: FeedbackReportView;
  binding?: string;
  feedback?: { outcome: (typeof FEEDBACK_OUTCOMES)[number]; reportId?: string };
  undelivered?: true;
}

/** The stored body read back as a report; null unless it has exactly the report's fields and limits. */
function toFeedbackReport(text: string): FeedbackReportView | null {
  if (Buffer.byteLength(text) > MAX_FEEDBACK_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlainObject(value) || Object.keys(value).join() !== FEEDBACK_REPORT_KEYS.join()) return null;
  const { area, kind, title, tried, happened, expected, agent } = value;
  if (area !== "other" || !FEEDBACK_TYPES.some(known => known === kind) || agent !== FEEDBACK_AGENT) return null;
  const field = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && [...value].length <= max;
  if (!field(title, MAX_FEEDBACK_TITLE) || /[\r\n]/.test(title)) return null;
  if (!field(tried, MAX_FEEDBACK_FIELD) || !field(happened, MAX_FEEDBACK_FIELD) || !field(expected, MAX_FEEDBACK_FIELD)) return null;
  return { area, kind: kind as FeedbackReportView["kind"], title, tried, happened, expected, agent };
}

/** Rebuilds one feedback proposal from the contract fields; null when the shape is wrong. */
function toFeedbackRequest(value: Record<string, unknown>): FeedbackRequestView | null {
  const { id, state, askedAt, expiresAt, outside, resolvedAt, targets, text, binding, outcomes, feedback, undelivered } = value;
  if (typeof id !== "string" || !ASK_REQUEST_ID.test(id) || !ACTION_STATES.some(known => known === state)) return null;
  if (!shortText(askedAt, 40) || !shortText(expiresAt, 40) || typeof outside !== "boolean") return null;
  if (resolvedAt !== undefined && !shortText(resolvedAt, 40)) return null;
  if (!Array.isArray(targets) || targets.length > 0 || (outcomes !== undefined && (!Array.isArray(outcomes) || outcomes.length > 0))) return null;
  const report = typeof text === "string" ? toFeedbackReport(text) : undefined;
  if (report === null || (text !== undefined && typeof text !== "string")) return null;
  if (binding !== undefined && (typeof binding !== "string" || !ACTION_BINDING.test(binding))) return null;
  if (undelivered !== undefined && undelivered !== true) return null;
  let sent: FeedbackRequestView["feedback"];
  if (feedback !== undefined) {
    if (!isPlainObject(feedback)) return null;
    const outcome = FEEDBACK_OUTCOMES.find(known => known === feedback.outcome);
    if (!outcome) return null;
    const reportId = outcome === "filed" && typeof feedback.reportId === "string" && FEEDBACK_REPORT_ID.test(feedback.reportId) ? feedback.reportId : undefined;
    sent = { outcome, ...(reportId ? { reportId } : {}) };
  }
  return {
    id, kind: "action", action: "send_feedback", state: state as FeedbackRequestView["state"], askedAt, expiresAt, outside,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(report ? { report } : {}),
    ...(binding !== undefined ? { binding } : {}),
    ...(sent ? { feedback: sent } : {}),
    ...(undelivered ? { undelivered: true as const } : {}),
  };
}

type RequestView = AskRequestView | ActionRequestView | FeedbackRequestView;

const isFeedbackRequest = (value: unknown): value is Record<string, unknown> => isPlainObject(value) && value.kind === "action" && value.action === "send_feedback";

/** One question or proposal, by its kind. */
function toRequest(value: unknown, names: ReadonlyMap<string, string>): RequestView | null {
  if (isFeedbackRequest(value)) return toFeedbackRequest(value);
  if (isPlainObject(value) && value.kind === "action") return toActionRequest(value, names);
  return toAskRequest(value);
}

/** The owner's requests; feedback proposals only when the app asked for them (`include=feedback`), else left out. */
function toAskRequests(payload: unknown, names: ReadonlyMap<string, string>, includeFeedback: boolean): { requests: RequestView[] } | null {
  if (!isPlainObject(payload) || !Array.isArray(payload.requests) || payload.requests.length > MAX_LISTED_REQUESTS) return null;
  const requests = payload.requests.filter(request => includeFeedback || !isFeedbackRequest(request)).map(request => toRequest(request, names));
  return requests.every(request => request !== null) ? { requests: requests as RequestView[] } : null;
}

/**
 * Builds the internal send body from the authenticated owner and route's admitted bot. With a typed message, the
 * browser's local date and time zone go along only when they are well formed; anything else is dropped and the turn
 * still runs. The bot's name goes along as `botName`, which only words its prompt.
 */
export async function botTurnBody(config: BotsConfig, address: string, sourceKey: string, text: string, appReply?: AppReply, clientContext?: unknown) {
  const context = appReply ? undefined : clientContextFrom(clientContext);
  const content = appReply ? { appReply } : { text, ...(context ? { clientContext: context } : {}) };
  const ownerDid = botOwnerDid(address);
  // A registry read failure leaves the turn without messaging, and the bot's prompt with its default name.
  const [messageableBotKeys, botName] = await Promise.all([
    config.listForTurn?.(ownerDid, sourceKey).catch(() => undefined),
    config.nameForTurn?.(ownerDid, sourceKey).catch(() => undefined),
  ]);
  return { ...content, ...(messageableBotKeys?.length ? { messageableBotKeys } : {}), ...(botName !== undefined ? { botName } : {}) };
}

/**
 * Headers for one signed call to the bots service at `url`, with exactly `body`. Each call needs its own headers.
 */
export function botsServiceHeaders(config: BotsConfig, ownerDid: string, method: string, url: string, body?: string): Record<string, string> {
  const { pathname, search } = new URL(url);
  const bot = /^\/v1\/bots\/([^/]+)/.exec(pathname)?.[1] ?? "";
  const authorization = signedCallHeader(config.serviceSecret, {
    direction: "to-service", environment: config.environment ?? "private", owner: ownerDid, bot, method, path: pathname + search, body,
  });
  return body === undefined ? { authorization } : { authorization, "content-type": "application/json" };
}

/**
 * Bots are off unless BOTS_ENABLED is exactly "true" AND BOTS_SERVICE_URL, BOTS_SERVICE_SECRET and a non-empty
 * BOTS_TEST_ACCOUNTS are set. The single entry `*` admits every account; an empty list admits nobody.
 */
export function botsFromEnv(env: Record<string, string | undefined>): BotsConfig | undefined {
  const connectHost = env.BOTS_SERVICE_CONNECT_HOST?.trim();
  if (connectHost) validateBotsConnectHost(env.BOTS_SERVICE_URL ?? "", connectHost);
  if (env.BOTS_ENABLED !== "true") return undefined;
  const serviceUrl = env.BOTS_SERVICE_URL?.trim().replace(/\/$/, "");
  const serviceSecret = env.BOTS_SERVICE_SECRET;
  const accounts = new Set((env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean));
  if (!serviceUrl || !serviceSecret || accounts.size === 0) {
    console.warn("[startup] BOTS_ENABLED is set but the bots configuration is incomplete; bots are disabled.");
    return undefined;
  }
  const postTimeoutMs = Number(env.BOTS_POST_TIMEOUT_MS ?? "");
  return {
    serviceUrl, serviceSecret,
    ...(connectHost ? { fetchImpl: botsConnectFetch(serviceUrl, connectHost) } : {}),
    postTimeoutMs: Number.isInteger(postTimeoutMs) && postTimeoutMs > 0 ? postTimeoutMs : 120_000,
    accountAllowed: address => accounts.has("*") || accounts.has(address.toLowerCase()) };
}

/**
 * Tells the service a bot's state under the counter of the owner's record. The service ignores anything older than
 * what it holds, so a late or repeated call is harmless. Answers whether the service took it.
 */
export async function announceBot(config: BotsConfig, address: string, key: string, state: "active" | "suspended" | "deleting", seq: number): Promise<boolean> {
  try {
    const url = `${config.serviceUrl}/v1/bots/${key}`;
    const body = JSON.stringify({ state, seq });
    const response = await (config.fetchImpl ?? fetch)(url, { method: "PUT", headers: botsServiceHeaders(config, botOwnerDid(address), "PUT", url, body), body, signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Asks the bots service to remove a bot's working state. The service is first told the bot is being deleted, under
 * the counter of the owner's record, so a removal can never act on an older state. Only an explicit answer counts as
 * `gone`; anything unclear is `failed`, and the caller tries again later.
 */
export async function removeBotFromService(config: BotsConfig, address: string, key: string, seq: number): Promise<"gone" | "waiting" | "failed"> {
  if (!(await announceBot(config, address, key, "deleting", seq))) return "failed";
  try {
    const url = `${config.serviceUrl}/v1/bots/${key}`;
    const response = await (config.fetchImpl ?? fetch)(url, { method: "DELETE", headers: botsServiceHeaders(config, botOwnerDid(address), "DELETE", url), signal: AbortSignal.timeout(30_000) });
    // The service was just told about this bot, so "not found" means it has already removed it for good.
    if (response.status === 404) return "gone";
    if (!response.ok) return "failed";
    const answer: unknown = await response.json();
    const outcome = typeof answer === "object" && answer !== null && "outcome" in answer ? answer.outcome : undefined;
    return outcome === "gone" || outcome === "waiting" ? outcome : "failed";
  } catch {
    return "failed";
  }
}

/** The same answer as UNAVAILABLE, for a bot other than Main. */
const BOT_UNAVAILABLE = { code: "bot_unavailable", message: "This bot can't be reached right now. Try again shortly." };

export function createBotsRouter(opts: {
  config?: BotsConfig; authMiddleware: RequestHandler; paidLimiter?: RequestHandler; registry?: BotsRegistry; capMode?: CapMode;
  /** The plan of an account, for the per-plan limit rule. */
  planOf?: (address: string) => Promise<PlanName | undefined>;
  /** Called once a bot is recorded as being deleted, to have the deletion carried out. It does not wait for it. */
  onDeleting?: (address: string, key: string) => void;
}): Router {
  const { registry } = opts;
  const capMode = opts.capMode ?? CAP_MODE;
  /** The account's plan, asked for only under the per-plan rule. One that cannot be read is undefined: none is guessed. */
  const accountPlan = async (address: string): Promise<PlanName | undefined> => {
    if (capMode !== "table") return undefined;
    try {
      return await opts.planOf?.(address);
    } catch {
      return undefined;
    }
  };
  const router = Router();
  const { config } = opts;
  router.use(opts.authMiddleware);

  const enabledFor = (req: Request): boolean => Boolean(config && req.user && config.accountAllowed(req.user.address));
  const gate = (req: Request, res: Response): string | null => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated", message: "Authentication required" }); return null; }
    if (!enabledFor(req)) { res.status(404).json({ error: "not_found" }); return null; }
    return req.user.address;
  };

  /**
   * Tells the service a bot's state under the record's counter. The service ignores anything older than what it
   * holds, so a late or repeated call is harmless. Answers whether the service took it.
   */
  const announce = (address: string, key: string, state: "active" | "suspended" | "deleting", seq: number): Promise<boolean> => announceBot(config!, address, key, state, seq);

  router.get("/status", (req, res) => {
    res.json({ enabled: enabledFor(req) });
  });

  // The owner's bots, and how many more may be created. The owner is the session address; nothing in the request names one.
  router.get("/", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const row = await registry.read(address);
      res.json({ bots: orderedBots(row).map(publicBot), deleted: row.deleted.map(publicDeleted), ...botCaps(capMode, await accountPlan(address), row) });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  // Main's web access setting (user-enabled, off by default). The service owns the rules; this only proxies, and
  // rebuilds the answer from the contract fields so nothing else the service returns reaches the browser.
  const webUrl = `/v1/bots/main/web`;
  const callWeb = async (address: string, init: { method: "GET" | "PUT"; body?: string }): Promise<globalThis.Response> =>
    (config!.fetchImpl ?? fetch)(`${config!.serviceUrl}${webUrl}`, {
      method: init.method,
      headers: botsServiceHeaders(config!, botOwnerDid(address), init.method, `${config!.serviceUrl}${webUrl}`, init.body),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(10_000),
    });
  const sendWeb = async (res: Response, upstream: Promise<globalThis.Response>): Promise<void> => {
    try {
      const response = await upstream;
      if (response.status === 400) {
        const message: unknown = ((await response.json().catch(() => null)) as { message?: unknown } | null)?.message;
        res.status(400).json({ error: "invalid", message: typeof message === "string" && message.length > 0 && message.length <= MAX_WEB_MESSAGE ? message : WEB_INVALID_MESSAGE });
        return;
      }
      if (!response.ok) throw new Error("upstream");
      const settings = toWebSettings(await response.json());
      if (!settings) throw new Error("shape");
      res.json(settings);
    } catch {
      res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message });
    }
  };

  router.get("/main/web", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await sendWeb(res, callWeb(address, { method: "GET" }));
  });

  router.put("/main/web", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const body = webSettingsBody(req.body);
    if (!body) { res.status(400).json({ error: "invalid", message: WEB_INVALID_MESSAGE }); return; }
    await sendWeb(res, callWeb(address, { method: "PUT", body: JSON.stringify(body) }));
  });

  // Questions from Main (user-enabled, off by default). The service holds the setting and the requests; this proxies them
  // with the owner taken from the session, and rebuilds each answer from the contract fields. A service that does not
  // have them answers 404, which is passed on so the app can leave the feature out.
  const callAsks = async (address: string, init: { method: "GET" | "PUT" | "POST"; path: string; body?: string }): Promise<globalThis.Response> => {
    const url = `${config!.serviceUrl}/v1/bots/main${init.path}`;
    return (config!.fetchImpl ?? fetch)(url, {
      method: init.method,
      headers: botsServiceHeaders(config!, botOwnerDid(address), init.method, url, init.body),
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: AbortSignal.timeout(10_000),
    });
  };
  const sendAsks = async (res: Response, upstream: Promise<globalThis.Response>, rebuild: (payload: unknown) => unknown | Promise<unknown>, decided = false): Promise<void> => {
    try {
      const response = await upstream;
      // A Send for a chat that holds the owner's private data is refused with `held`; any other 409 is a decided request.
      const held = decided && response.status === 409 && (await response.clone().json().catch(() => null) as { error?: unknown } | null)?.error === "held";
      const refused = response.status === 404 ? { status: 404, error: "not_found" } : held ? { status: 409, error: "held" }
        : decided && response.status === 409 ? { status: 409, error: "not_pending" }
        : response.status === 400 ? { status: 400, error: "invalid" } : undefined;
      if (refused) {
        await response.body?.cancel();
        res.status(refused.status).json({ error: refused.error });
        return;
      }
      if (!response.ok) throw new Error("upstream");
      const shaped = await rebuild(await response.json());
      if (shaped === null) throw new Error("shape");
      res.json(shaped);
    } catch {
      res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message });
    }
  };

  router.get("/main/asks", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await sendAsks(res, callAsks(address, { method: "GET", path: "/asks" }), toAsksSettings);
  });

  router.put("/main/asks", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const body = asksSettingsBody(req.body);
    if (!body) { res.status(400).json({ error: "invalid" }); return; }
    await sendAsks(res, callAsks(address, { method: "PUT", path: "/asks", body: JSON.stringify(body) }), toAsksSettings);
  });

  /** The owner's bots' names by key, for proposal cards; empty when there is no registry or it cannot be read. */
  const botNames = async (address: string): Promise<Map<string, string>> => {
    try {
      return new Map(registry ? (await registry.read(address)).bots.map(bot => [bot.key, bot.name]) : []);
    } catch {
      return new Map();
    }
  };

  router.get("/main/requests", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    // Feedback proposals go only to an app that shows their card; the service is asked for the same list either way.
    const includeFeedback = req.query.include === "feedback";
    await sendAsks(res, callAsks(address, { method: "GET", path: "/requests" }), async payload => toAskRequests(payload, await botNames(address), includeFeedback));
  });

  router.post("/main/requests/:id/answer", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const id = req.params.id;
    if (!ASK_REQUEST_ID.test(id)) { res.status(404).json({ error: "not_found" }); return; }
    const body = askAnswerBody(req.body);
    if (!body) { res.status(400).json({ error: "invalid" }); return; }
    // A Send reaches only the bots the registry admits for Main now; the service checks each again as it delivers.
    let sent: Record<string, unknown> = body;
    if (body.decision === "approve") {
      try {
        sent = { ...body, messageableBotKeys: await config!.listForTurn?.(botOwnerDid(address), MAIN_BOT_KEY) ?? [] };
      } catch {
        res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message });
        return;
      }
    }
    await sendAsks(res, callAsks(address, { method: "POST", path: `/requests/${id}/answer`, body: JSON.stringify(sent) }), async payload => toRequest(payload, await botNames(address)), true);
  });

  // The owner's "Start a new chat" with Main: the service clears the conversation and its pending questions, and keeps
  // the owner's settings. Only this route asks for it, with the owner taken from the session; no bot, tool or turn can.
  router.post("/main/new-chat", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    try {
      const response = await callAsks(address, { method: "POST", path: "/new-chat" });
      const payload = (await response.json().catch(() => null)) as { outcome?: unknown; error?: unknown } | null;
      if (response.ok && payload?.outcome === "cleared") { res.json({ outcome: "cleared" }); return; }
      if (response.status === 409 && (payload?.error === "busy" || payload?.error === "archive_pending")) { res.status(409).json({ error: payload.error }); return; }
      if (response.status === 404) { res.status(404).json({ error: "not_found" }); return; }
    } catch { /* answered below */ }
    res.status(502).json({ error: UNAVAILABLE.code, message: UNAVAILABLE.message });
  });

  // Creates a bot for the signed-in owner. Its key is chosen here; the request names neither an owner nor a key.
  router.post("/", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const { limits } = botCaps(capMode, await accountPlan(address), await registry.read(address));
      if (!limits) { res.status(503).json({ error: "bots_unavailable" }); return; }
      const created = await registry.create(address, { name: req.body?.name, shape: req.body?.shape, colour: req.body?.colour }, limits.private.max);
      if (!created.ok) {
        const status = created.error === "name_taken" || created.error === "bot_limit" ? 409 : 400;
        res.status(status).json(created.error === "bot_limit" ? { error: "bot_limit", environment: "private" } : { error: created.error });
        return;
      }
      // If this fails the bot still exists; a message to it announces it again.
      await announce(address, created.bot.key, "active", created.seq);
      res.status(201).json({ bot: created.bot });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  /**
   * The bot a keyed route acts on, taken from the signed-in owner's own record. A malformed key is refused before
   * anything is looked up, and a key that is not in that record before the service is called. Answers 404 or 503
   * itself and returns undefined.
   */
  const ownBot = async (res: Response, address: string, key: string): Promise<{ bot: Bot; seq: number } | undefined> => {
    if (!registry || !BOT_KEY.test(key)) { res.status(404).json({ error: "not_found" }); return undefined; }
    try {
      const row = await registry.read(address);
      const bot = row.bots.find(candidate => candidate.key === key);
      if (bot) return { bot, seq: row.seq };
      res.status(404).json({ error: "not_found" });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
    return undefined;
  };

  /**
   * One call to the service for a bot. Main exists there without being announced; any other bot exists there only
   * once announced. So if the service does not know a bot the record says is active, it is told again, once, and
   * the call is made again. `call` builds a fresh request each time. `seq` is the record's counter, absent for Main.
   */
  const callBot = async (address: string, key: string, seq: number | undefined, call: () => Promise<globalThis.Response>): Promise<globalThis.Response> => {
    const first = await call();
    if (first.status !== 404 || seq === undefined || !(await announce(address, key, "active", seq))) return first;
    await first.body?.cancel();
    return call();
  };

  const readMessages = async (res: Response, address: string, key: string, seq?: number): Promise<void> => {
    const unavailable = key === MAIN_BOT_KEY ? UNAVAILABLE : BOT_UNAVAILABLE;
    try {
      const url = `${config!.serviceUrl}/v1/bots/${key}/messages`;
      const upstream = await callBot(address, key, seq, () => (config!.fetchImpl ?? fetch)(url, {
        headers: botsServiceHeaders(config!, botOwnerDid(address), "GET", url),
        signal: AbortSignal.timeout(key === MAIN_BOT_KEY ? BOTS_HISTORY_GET_TIMEOUT_MS : 10_000),
      }));
      if (!upstream.ok) { res.status(502).json({ error: unavailable.code, message: unavailable.message }); return; }
      const listed = await upstream.json() as { messages: unknown; activity?: unknown };
      if (listed && Object.hasOwn(listed, "activity")) {
        const { activity, ...rest } = listed;
        const records = Array.isArray(activity) ? activity.filter(isBotActivityRecord) : [];
        res.json({ ...rest, ...(records.length ? { activity: records } : {}) });
      } else {
        res.json(listed);
      }
    } catch {
      res.status(502).json({ error: unavailable.code, message: unavailable.message });
    }
  };

  router.get("/main/messages", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await readMessages(res, address, MAIN_BOT_KEY);
  });

  router.get("/:key/messages", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const own = await ownBot(res, address, req.params.key);
    if (!own) return;
    // The service answers the same for a bot that is being deleted; say so here, without asking it.
    if (own.bot.state === "deleting") { res.status(409).json({ error: "bot_not_active", state: own.bot.state }); return; }
    await readMessages(res, address, own.bot.key, own.seq);
  });

  // One turn: the owner's text goes to the bot `key` names, and the service's events stream back.
  const sendMessage = async (req: Request, res: Response, address: string, key: string, seq?: number): Promise<void> => {
    // An owner's decision on a question from Main goes to Main as `appReply`: only the request's id is taken from the
    // browser. The text Main receives is composed by the service from what it stored; any `text` sent with it is not forwarded.
    const rawReply: unknown = req.body?.appReply;
    const checkedReply = rawReply === undefined ? undefined : appReplyBody(rawReply);
    if (checkedReply === null || (rawReply !== undefined && key !== MAIN_BOT_KEY)) {
      res.status(400).json({ error: "invalid", message: "That reply can't be sent." });
      return;
    }
    const appReply = checkedReply;
    const text: unknown = req.body?.text;
    if (!appReply && (typeof text !== "string" || text.length < 1 || text.length > MAX_TEXT)) {
      res.status(400).json({ error: "invalid", message: "Messages can be up to 8,000 characters." });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on("close", abort);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, config!.postTimeoutMs);

    const open = () => {
      if (res.headersSent) return;
      res.status(200);
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("x-accel-buffering", "no");
      res.flushHeaders();
    };
    // A normal turn opens its stream at once; a reply waits for the service's answer so a refusal can be a plain 409.
    if (!appReply) open();

    try {
      const url = `${config!.serviceUrl}/v1/bots/${key}/messages`;
      const body = JSON.stringify(await botTurnBody(config!, address, key, typeof text === "string" ? text : "", appReply, req.body?.clientContext));
      const upstream = await callBot(address, key, seq, () => (config!.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: botsServiceHeaders(config!, botOwnerDid(address), "POST", url, body),
        body,
        signal: controller.signal,
      }));
      // A decision that cannot be delivered (not decided, already delivered, not this owner's) is a plain 409, before any stream is opened.
      if (appReply && upstream.status === 409) {
        await upstream.body?.cancel();
        res.status(409).json({ error: "no_reply" });
        return;
      }
      if (!upstream.ok || !upstream.body) throw new Error("upstream");
      open();
      const reader = upstream.body.getReader();
      // Release a pending read even if the upstream body ignores the abort signal.
      controller.signal.addEventListener("abort", () => { reader.cancel().catch(() => {}); }, { once: true });
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error("aborted");
        if (done) break;
        if (!res.write(value)) {
          // Backpressure: read the next upstream chunk only once the client has taken this one (or the turn ended).
          let resolve!: () => void;
          const drained = new Promise<void>(done => { resolve = done; }); // backend lib predates Promise.withResolvers
          res.once("drain", resolve);
          controller.signal.addEventListener("abort", resolve);
          await drained;
          res.off("drain", resolve);
          controller.signal.removeEventListener("abort", resolve);
        }
      }
    } catch {
      open();
      if ((timedOut || !controller.signal.aborted) && !res.writableEnded) {
        res.write(`event: error\ndata: ${JSON.stringify(key === MAIN_BOT_KEY ? UNAVAILABLE : BOT_UNAVAILABLE)}\n\n`);
      }
    } finally {
      clearTimeout(timer);
      res.off("close", abort);
      if (!res.writableEnded) res.end();
      config!.onTurnFinished?.();
    }
  };

  const paidLimiter: RequestHandler = opts.paidLimiter ?? ((_req, _res, next) => next());

  // Each send starts a model call in the bot, so it is charged to the paid-chat limiter like /api/agent/chat.
  router.post("/main/messages", paidLimiter, async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    await sendMessage(req, res, address, MAIN_BOT_KEY);
  });

  router.post("/:key/messages", paidLimiter, async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    const own = await ownBot(res, address, req.params.key);
    if (!own) return;
    if (own.bot.state !== "active") { res.status(409).json({ error: "bot_not_active", state: own.bot.state }); return; }
    await sendMessage(req, res, address, own.bot.key, own.seq);
  });

  // Renames or restyles a bot, Main included. Only the name, the shape and the colour are taken from the request.
  router.patch("/:key", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const updated = await registry.update(address, req.params.key, { name: req.body?.name, shape: req.body?.shape, colour: req.body?.colour });
      if (updated.ok) { res.json({ bot: updated.bot }); return; }
      const status = updated.error === "not_found" ? 404 : updated.error === "name_taken" || updated.error === "bot_deleting" ? 409 : 400;
      res.status(status).json({ error: updated.error });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  // Starts deleting a bot. The record says so before the service is told, and everything after that happens later.
  router.delete("/:key", async (req, res) => {
    const address = gate(req, res);
    if (!address) return;
    if (!registry) { res.status(404).json({ error: "not_found" }); return; }
    try {
      const begun = await registry.beginDelete(address, req.params.key);
      if (!begun.ok) { res.status(begun.error === "not_found" ? 404 : 409).json({ error: begun.error }); return; }
      // If this fails the deletion still stands: the service is told again when the deletion is carried out.
      await announce(address, begun.bot.key, "deleting", begun.seq);
      opts.onDeleting?.(address, begun.bot.key);
      res.status(202).json({ bot: publicBot(begun.bot) });
    } catch {
      res.status(503).json({ error: "bots_unavailable" });
    }
  });

  return router;
}
