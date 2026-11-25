// Environment for the two bots processes: the supervisor (not privileged, but holds what runsc needs; runs the
// sandboxes, answers the backend) and the egress gateway (unprivileged, the only holder of the model key).
// The supervisor holds its control key and the gateway holds the backend admission secret.

import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL = "z-ai/glm-5.2";
export const PINNED_UPSTREAM = "https://tee.redpill.ai";
export const DEFAULT_BACKEND_ORIGIN = "https://api.tinycloud.chat";
/** 256 bits, hex or base64url encoded. */
const MIN_SERVICE_SECRET_CHARS = 43;

function int(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function backendCallSecret(env: Env): string | undefined {
  const secret = env.BOTS_BACKEND_CALL_SECRET || undefined;
  if (secret && secret.length < MIN_SERVICE_SECRET_CHARS) {
    throw new Error("BOTS_BACKEND_CALL_SECRET must be a unique 256-bit secret");
  }
  return secret;
}

/**
 * Per-bot budget. memoryMb is the sandbox's cgroup limit and bounds everything it holds: processes, the writable
 * root layer, /tmp and the state it writes (all three live in memory). A bot that exceeds it is killed alone.
 */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /** Cap on the writable root layer (in memory, inside memoryMb). */
  overlayMb: number;
  /** Cap on /tmp (in memory, inside memoryMb). */
  tmpMb: number;
  /** Size of the owner's state tmpfs (in memory, inside memoryMb), and the cap on its saved copy on disk. */
  stateMb: number;
}

/** BOTS_ACCEPT_LEGACY_OWNER_HEADER: `0` (the default) or `1`; anything else is refused. See README, "Deploy order". */
export function legacyOwnerHeaderAccepted(env: Env): boolean {
  const raw = env.BOTS_ACCEPT_LEGACY_OWNER_HEADER?.trim() ?? "";
  if (raw !== "" && raw !== "0" && raw !== "1") throw new Error("BOTS_ACCEPT_LEGACY_OWNER_HEADER must be 0 or 1");
  return raw === "1";
}

export interface SupervisorConfig {
  port: number;
  serviceSecret: string;
  admissionControlKey?: string;
  /** Lowercased addresses, or "*" for every account. Empty admits nobody. */
  accounts: Set<string> | "*";
  acceptLegacyOwnerHeader: boolean;
  model: string;
  idleMs: number;
  dataRoot: string;
  runRoot: string;
  egressRoot: string;
  rootfs: string;
  runscRoot: string;
  limits: SandboxLimits;
  /** All running sandboxes together: the parent cgroup's memory.max and pids.max. */
  totalMemoryMb: number;
  totalPids: number;
  /** Sandboxes running at once; a start past it is refused. */
  maxRunning: number;
  /** One owner's bots, Main included, that this service will hold. A new one past it is refused when announced. */
  maxBotsPerOwner: number;
  /** A state copy (restore or save) still running by then is killed and counts as failed. */
  stateCopyTimeoutMs: number;
  /** A turn with no prompt_result by then is ended and its sandbox killed. */
  turnTimeoutMs: number;
  /** Assistant text bytes streamed per turn before it is cut off. */
  maxTurnBytes: number;
  /** A bot's working state is deleted once it has gone unused for this many days. */
  retentionDays: number;
  history?: { signerDid: string; host: string; policy: "notice-then-expiry-30-days" };
}

export function supervisorConfig(env: Env): SupervisorConfig {
  const serviceSecret = required(env, "BOTS_SERVICE_SECRET");
  if (serviceSecret.length < MIN_SERVICE_SECRET_CHARS) {
    throw new Error("BOTS_SERVICE_SECRET must be a unique 256-bit secret (openssl rand -hex 32)");
  }
  const controlKey = env.BOTS_ADMISSION_CONTROL_KEY || undefined;
  if (controlKey && !/^[A-Za-z0-9_-]{43}$/.test(controlKey)) {
    throw new Error("BOTS_ADMISSION_CONTROL_KEY must be a 32-byte base64url key");
  }
  const list = (env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const limits: SandboxLimits = {
    memoryMb: int(env, "BOTS_SANDBOX_MEMORY_MB", 1536, 256),
    cpus: int(env, "BOTS_SANDBOX_CPUS", 1),
    pids: int(env, "BOTS_SANDBOX_PIDS", 256, 16),
    overlayMb: int(env, "BOTS_SANDBOX_OVERLAY_MB", 512, 64),
    tmpMb: int(env, "BOTS_SANDBOX_TMP_MB", 256, 16),
    stateMb: int(env, "BOTS_STATE_MB", 256, 16),
  };
  // Leave room for the processes themselves, so a full root layer, /tmp and state still fit under the cgroup limit.
  if (limits.overlayMb + limits.tmpMb + limits.stateMb + 512 > limits.memoryMb) {
    throw new Error("BOTS_SANDBOX_MEMORY_MB must exceed BOTS_SANDBOX_OVERLAY_MB + BOTS_SANDBOX_TMP_MB + BOTS_STATE_MB by at least 512");
  }
  const totalMemoryMb = int(env, "BOTS_TOTAL_MEMORY_MB", 6144, 256);
  // Per running bot: its sandbox's limit, plus its restored state, which the restore writes outside the sandbox's
  // cgroup but still under the parent's. At the cap every running bot can use all of it without reaching
  // BOTS_TOTAL_MEMORY_MB.
  const perBotMb = limits.memoryMb + limits.stateMb;
  if (totalMemoryMb < perBotMb) throw new Error("BOTS_TOTAL_MEMORY_MB must be at least BOTS_SANDBOX_MEMORY_MB + BOTS_STATE_MB");
  const maxRunning = int(env, "BOTS_MAX_RUNNING", Math.floor(totalMemoryMb / perBotMb));
  if (maxRunning * perBotMb > totalMemoryMb) {
    throw new Error("BOTS_MAX_RUNNING x (BOTS_SANDBOX_MEMORY_MB + BOTS_STATE_MB) must not exceed BOTS_TOTAL_MEMORY_MB");
  }
  return {
    port: int(env, "PORT", 8080),
    serviceSecret,
    admissionControlKey: controlKey,
    accounts: list.includes("*") ? "*" : new Set(list),
    acceptLegacyOwnerHeader: legacyOwnerHeaderAccepted(env),
    model: env.BOTS_MODEL?.trim() || DEFAULT_MODEL,
    idleMs: int(env, "BOTS_IDLE_MS", 10 * 60_000, 1000),
    dataRoot: env.BOTS_DATA_ROOT ?? "/data/bots",
    runRoot: env.BOTS_RUN_ROOT ?? "/run/bots",
    egressRoot: env.BOTS_EGRESS_ROOT ?? "/egress",
    rootfs: env.BOTS_ROOTFS ?? "/bot-rootfs",
    runscRoot: env.BOTS_RUNSC_ROOT ?? "/run/runsc",
    limits,
    totalMemoryMb,
    totalPids: int(env, "BOTS_TOTAL_PIDS", 2048, 16),
    maxRunning,
    maxBotsPerOwner: int(env, "BOTS_MAX_PER_OWNER", 10),
    stateCopyTimeoutMs: int(env, "BOTS_STATE_COPY_TIMEOUT_MS", 60_000, 1000),
    turnTimeoutMs: int(env, "BOTS_TURN_TIMEOUT_MS", 5 * 60_000, 1000),
    maxTurnBytes: int(env, "BOTS_MAX_TURN_BYTES", 256 * 1024, 1024),
    retentionDays: int(env, "BOTS_RETENTION_DAYS", 30),
    history: env.BOTS_HISTORY_ENABLED === "true" ? {
      signerDid: required(env, "BOTS_HISTORY_SIGNER_DID"),
      host: required(env, "BOTS_HISTORY_NODE_ORIGIN"),
      policy: (() => { if ((env.BOTS_UNARCHIVED_HISTORY_POLICY ?? "notice-then-expiry-30-days") !== "notice-then-expiry-30-days") throw new Error("BOTS_UNARCHIVED_HISTORY_POLICY must be notice-then-expiry-30-days"); return "notice-then-expiry-30-days" as const; })(),
    } : undefined,
  };
}

export interface GatewayConfig {
  egressRoot: string;
  modelKey: string;
  upstream: string;
  models: string[];
  maxTokens: number;
  botDailyTokens: number;
  /** All of one owner's bots together, per UTC day. Unset: the same as one bot's limit. */
  ownerDailyTokens?: number;
  globalDailyTokens: number;
  /** Settled tokens per turn above this value get an operator log; zero disables it. */
  turnSoftLimit?: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  /** Deadline for a request body to arrive once the bot holds its slot. */
  bodyTimeoutMs: number;
  /** Where the daily budget counters persist across restarts. */
  budgetFile: string;
  /** Which owner each bot belongs to, kept across restarts beside the budget file. Unset: not kept. */
  ownersFile?: string;
  /** Web access for Main. Absent in a config that predates it; without a key every web call is refused. */
  web?: WebConfig;
  /** Sealed secret-request records (secret-store.ts), beside the budget file. */
  secretGrantsDir?: string;
  /** Where `send_feedback` reports go: FEEDBACK_ORIGIN, or a loopback mock in tests. Unset: FEEDBACK_ORIGIN. */
  feedbackUrl?: string;
}

/** Where secret requests go: TinyCloud's own node, links API and OpenKey. Pinned like the model's upstream. */
export const SECRET_ORIGINS = {
  node: "https://node.tinycloud.xyz",
  linksApi: "https://api.tinycloud.xyz",
  openkey: "https://openkey.so",
  openkeyApi: "https://api.openkey.so",
} as const;

/** Where Main's feedback reports go (`send_feedback`, feedback.ts). Pinned like the secret origins. */
export const FEEDBACK_ORIGIN = "https://feedback.tinycloud.xyz";

/** The search provider behind Main's web tools and what one bot, and all bots, may use of it per UTC day. */
export interface WebConfig {
  /** Undefined until the gateway is given a key: web calls are then refused as unavailable. */
  key: string | undefined;
  apiUrl: string;
  botDailySearches: number;
  botDailyPages: number;
  globalDailySearches: number;
  globalDailyPages: number;
  /** Per call, against the provider. */
  timeoutMs: number;
  /** Our key-less page-reading process on the private link network. */
  fetchUrl: string;
  /** Per page: a little over the fetch process's own deadline, so its answer is the one that ends the call. */
  fetchTimeoutMs: number;
}

export const PINNED_WEB_API = "https://api.tavily.com";
/** The page-reading process, by its compose service name; BOTS_TEST_FETCH_URL exists only for loopback mocks. */
export const PINNED_FETCH_URL = "http://bots-fetch:8080";

function fetchService(env: Env): string {
  const raw = env.BOTS_TEST_FETCH_URL?.trim();
  if (!raw) return PINNED_FETCH_URL;
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("BOTS_TEST_FETCH_URL may only point at a loopback mock");
  }
  console.warn(JSON.stringify({ gateway: "test_fetch_service", upstream: url.origin }));
  return url.origin;
}

/** The provider's origin is pinned like the model's; BOTS_TEST_WEB_URL exists only for loopback mocks. */
function webApi(env: Env): string {
  const raw = env.BOTS_TEST_WEB_URL?.trim();
  if (!raw) return PINNED_WEB_API;
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("BOTS_TEST_WEB_URL may only point at a loopback mock");
  }
  console.warn(JSON.stringify({ gateway: "test_web_api", upstream: url.origin }));
  return url.origin;
}

/**
 * The upstream is pinned. BOTS_TEST_UPSTREAM_URL exists only for the local mock smoke and may only name a
 * loopback address; the deploy compose never passes it, so it cannot be set in a CVM.
 */
function upstream(env: Env): string {
  const raw = env.BOTS_TEST_UPSTREAM_URL?.trim();
  if (!raw) return PINNED_UPSTREAM;
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("BOTS_TEST_UPSTREAM_URL may only point at a loopback mock");
  }
  console.warn(JSON.stringify({ gateway: "test_upstream", upstream: url.origin }));
  return url.origin;
}

/** The feedback origin is pinned; BOTS_TEST_FEEDBACK_URL exists only for loopback mocks, like BOTS_TEST_UPSTREAM_URL. */
function feedbackService(env: Env): string {
  const raw = env.BOTS_TEST_FEEDBACK_URL?.trim();
  if (!raw) return FEEDBACK_ORIGIN;
  const url = new URL(raw);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("BOTS_TEST_FEEDBACK_URL may only point at a loopback mock");
  }
  console.warn(JSON.stringify({ gateway: "test_feedback_service", upstream: url.origin }));
  return url.origin;
}

function backendOrigin(env: Env): string {
  const raw = env.BACKEND_ORIGIN?.trim() || DEFAULT_BACKEND_ORIGIN;
  const url = URL.parse(raw);
  if (!url || url.protocol !== "https:" || (raw !== url.origin && raw !== `${url.origin}/`)) {
    throw new Error("BACKEND_ORIGIN must be an HTTPS origin");
  }
  return url.origin;
}

export function gatewayConfig(env: Env): GatewayConfig & { backendOrigin: string; backendCallSecret?: string } {
  const model = env.BOTS_MODEL?.trim() || DEFAULT_MODEL;
  const models = (env.BOTS_MODELS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const botDailyTokens = int(env, "BOTS_BOT_DAILY_TOKENS", 2_000_000);
  const budgetFile = env.BOTS_BUDGET_FILE ?? "/var/lib/bots-gateway/budget.json";
  return {
    egressRoot: env.BOTS_EGRESS_ROOT ?? "/egress",
    modelKey: required(env, "REDPILL_API_KEY"),
    upstream: upstream(env),
    backendOrigin: backendOrigin(env),
    backendCallSecret: backendCallSecret(env),
    models: models.length > 0 ? models : [model],
    maxTokens: int(env, "BOTS_MAX_TOKENS", 8192),
    botDailyTokens,
    ownerDailyTokens: int(env, "BOTS_OWNER_DAILY_TOKENS", botDailyTokens),
    globalDailyTokens: int(env, "BOTS_GLOBAL_DAILY_TOKENS", 20_000_000),
    turnSoftLimit: int(env, "BOTS_TURN_SOFT_LIMIT", 0, 0),
    maxBodyBytes: int(env, "BOTS_MAX_BODY_BYTES", 4 * 1024 * 1024, 1024),
    maxResponseBytes: int(env, "BOTS_MAX_RESPONSE_BYTES", 8 * 1024 * 1024, 1024),
    connectTimeoutMs: int(env, "BOTS_UPSTREAM_CONNECT_TIMEOUT_MS", 30_000, 100),
    totalTimeoutMs: int(env, "BOTS_UPSTREAM_TOTAL_TIMEOUT_MS", 10 * 60_000, 100),
    bodyTimeoutMs: int(env, "BOTS_BODY_TIMEOUT_MS", 30_000, 100),
    budgetFile,
    ownersFile: env.BOTS_OWNERS_FILE ?? join(dirname(budgetFile), "owners.json"),
    secretGrantsDir: join(dirname(budgetFile), "secret-grants"),
    feedbackUrl: feedbackService(env),
    web: {
      key: env.TAVILY_API_KEY?.trim() || undefined,
      apiUrl: webApi(env),
      botDailySearches: int(env, "BOTS_WEB_BOT_DAILY_SEARCHES", 100),
      botDailyPages: int(env, "BOTS_WEB_BOT_DAILY_PAGES", 300),
      globalDailySearches: int(env, "BOTS_WEB_GLOBAL_DAILY_SEARCHES", 2000),
      globalDailyPages: int(env, "BOTS_WEB_GLOBAL_DAILY_PAGES", 6000),
      timeoutMs: int(env, "BOTS_WEB_TIMEOUT_MS", 20_000, 100),
      fetchUrl: fetchService(env),
      fetchTimeoutMs: int(env, "BOTS_WEB_FETCH_TIMEOUT_MS", 25_000, 100),
    },
  };
}
