// Environment for the two bots processes: the supervisor (not privileged, but holds what runsc needs; runs the
// sandboxes, answers the backend) and the egress gateway (unprivileged, the only holder of the model key).
// Neither reads the other's secrets.

type Env = Record<string, string | undefined>;

export const DEFAULT_MODEL = "z-ai/glm-5.2";
export const PINNED_UPSTREAM = "https://tee.redpill.ai";
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

/**
 * Per-bot budget. memoryMb is the sandbox's cgroup limit and bounds everything it holds: processes, the writable
 * root layer and /tmp (both live in sandbox memory). A bot that exceeds it is killed alone.
 */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  /** Cap on the writable root layer (in memory, inside memoryMb). */
  overlayMb: number;
  /** Cap on /tmp (in memory, inside memoryMb). */
  tmpMb: number;
  /** Size of the owner's persistent state filesystem (on disk). */
  stateMb: number;
}

export interface SupervisorConfig {
  port: number;
  serviceSecret: string;
  /** Lowercased addresses, or "*" for every account. Empty admits nobody. */
  accounts: Set<string> | "*";
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
  /** A turn with no prompt_result by then is ended and its sandbox killed. */
  turnTimeoutMs: number;
  /** Assistant text bytes streamed per turn before it is cut off. */
  maxTurnBytes: number;
}

export function supervisorConfig(env: Env): SupervisorConfig {
  const serviceSecret = required(env, "BOTS_SERVICE_SECRET");
  if (serviceSecret.length < MIN_SERVICE_SECRET_CHARS) {
    throw new Error("BOTS_SERVICE_SECRET must be a unique 256-bit secret (openssl rand -hex 32)");
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
  // Leave room for the processes themselves, so a full root layer and /tmp still fit under the cgroup limit.
  if (limits.overlayMb + limits.tmpMb + 512 > limits.memoryMb) {
    throw new Error("BOTS_SANDBOX_MEMORY_MB must exceed BOTS_SANDBOX_OVERLAY_MB + BOTS_SANDBOX_TMP_MB by at least 512");
  }
  const totalMemoryMb = int(env, "BOTS_TOTAL_MEMORY_MB", 6144, 256);
  if (totalMemoryMb < limits.memoryMb) throw new Error("BOTS_TOTAL_MEMORY_MB must be at least BOTS_SANDBOX_MEMORY_MB");
  return {
    port: int(env, "PORT", 8080),
    serviceSecret,
    accounts: list.includes("*") ? "*" : new Set(list),
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
    turnTimeoutMs: int(env, "BOTS_TURN_TIMEOUT_MS", 5 * 60_000, 1000),
    maxTurnBytes: int(env, "BOTS_MAX_TURN_BYTES", 256 * 1024, 1024),
  };
}

export interface GatewayConfig {
  egressRoot: string;
  modelKey: string;
  upstream: string;
  models: string[];
  maxTokens: number;
  botDailyTokens: number;
  globalDailyTokens: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  /** Deadline for a request body to arrive once the bot holds its slot. */
  bodyTimeoutMs: number;
  /** Where the daily budget counters persist across restarts. */
  budgetFile: string;
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

export function gatewayConfig(env: Env): GatewayConfig {
  const model = env.BOTS_MODEL?.trim() || DEFAULT_MODEL;
  const models = (env.BOTS_MODELS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  return {
    egressRoot: env.BOTS_EGRESS_ROOT ?? "/egress",
    modelKey: required(env, "REDPILL_API_KEY"),
    upstream: upstream(env),
    models: models.length > 0 ? models : [model],
    maxTokens: int(env, "BOTS_MAX_TOKENS", 8192),
    botDailyTokens: int(env, "BOTS_BOT_DAILY_TOKENS", 2_000_000),
    globalDailyTokens: int(env, "BOTS_GLOBAL_DAILY_TOKENS", 20_000_000),
    maxBodyBytes: int(env, "BOTS_MAX_BODY_BYTES", 4 * 1024 * 1024, 1024),
    maxResponseBytes: int(env, "BOTS_MAX_RESPONSE_BYTES", 8 * 1024 * 1024, 1024),
    connectTimeoutMs: int(env, "BOTS_UPSTREAM_CONNECT_TIMEOUT_MS", 30_000, 100),
    totalTimeoutMs: int(env, "BOTS_UPSTREAM_TOTAL_TIMEOUT_MS", 10 * 60_000, 100),
    bodyTimeoutMs: int(env, "BOTS_BODY_TIMEOUT_MS", 30_000, 100),
    budgetFile: env.BOTS_BUDGET_FILE ?? "/var/lib/bots-gateway/budget.json",
  };
}
