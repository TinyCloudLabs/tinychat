// Environment for the regular runtime service. The model key is read by the gateway container (gateway-main.ts).

import type { SandboxResources } from "@getenergy/gke-sandboxes";

type Env = Record<string, string | undefined>;

/** 256 bits, hex or base64url encoded. */
const MIN_SERVICE_SECRET_CHARS = 43;
const DEFAULT_MODEL = "z-ai/glm-5.2";

function int(env: Env, name: string, fallback: number, min = 1): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** A Kubernetes quantity: "250m", "1", "1.5", "512Mi", "2Gi". */
const QUANTITY = /^\d+(\.\d+)?(m|Ki|Mi|Gi|Ti)?$/;

function quantity(env: Env, name: string, fallback: string): string {
  const value = env[name]?.trim() || fallback;
  if (!QUANTITY.test(value)) throw new Error(`${name} must be a Kubernetes quantity, such as 250m, 1, 512Mi or 2Gi`);
  return value;
}

/**
 * What each sandbox reserves on its machine (requests) and may use at most (limits). The scheduler places sandboxes by
 * their requests, so a machine holds about its allocatable memory divided by the memory request. Defaults suit one
 * small machine (2 vCPU, 8 GB).
 */
function resources(env: Env): SandboxResources {
  return {
    requests: {
      cpu: quantity(env, "BOTS_REGULAR_SANDBOX_CPU_REQUEST", "250m"),
      memory: quantity(env, "BOTS_REGULAR_SANDBOX_MEMORY_REQUEST", "1Gi"),
      "ephemeral-storage": quantity(env, "BOTS_REGULAR_SANDBOX_DISK_REQUEST", "2Gi"),
    },
    limits: {
      cpu: quantity(env, "BOTS_REGULAR_SANDBOX_CPU_LIMIT", "1"),
      memory: quantity(env, "BOTS_REGULAR_SANDBOX_MEMORY_LIMIT", "2Gi"),
      "ephemeral-storage": quantity(env, "BOTS_REGULAR_SANDBOX_DISK_LIMIT", "8Gi"),
    },
  };
}

export type ProviderConfig =
  | { kind: "gke"; apiUrl: string; namespace: string; serviceAccount: string; image: string; resources: SandboxResources }
  /** Bridges as processes on this machine with a stand-in agent: tests and local runs. */
  | { kind: "local"; root: string; agent: string[] };

export interface RegularConfig {
  port: number;
  serviceSecret: string;
  /** Lowercased addresses, or "*" for every account. Empty admits nobody. */
  accounts: Set<string> | "*";
  model: string;
  idleMs: number;
  dataRoot: string;
  runRoot: string;
  /** Bots awake at once, across all machines; one more is refused with at_capacity. */
  maxRunning: number;
  turnTimeoutMs: number;
  maxTurnBytes: number;
  retentionDays: number;
  startTimeoutMs: number;
  touchMs: number;
  /** The gateway container's control socket. */
  gatewayControlSocket: string;
  /** The gateway as sandboxes reach it. */
  gatewayOrigin: string;
  provider: ProviderConfig;
  history?: { signerDid: string; host: string; policy: "notice-then-expiry-30-days" };
}

function provider(env: Env): ProviderConfig {
  const kind = required(env, "BOTS_REGULAR_PROVIDER");
  if (kind === "gke") {
    const image = required(env, "BOTS_REGULAR_SANDBOX_IMAGE");
    if (!/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("BOTS_REGULAR_SANDBOX_IMAGE must be pinned by digest");
    return {
      kind,
      apiUrl: env.BOTS_REGULAR_KUBERNETES_URL?.trim() || "https://kubernetes.default.svc",
      namespace: env.BOTS_REGULAR_NAMESPACE?.trim() || "sandboxes",
      serviceAccount: env.BOTS_REGULAR_SANDBOX_SERVICE_ACCOUNT?.trim() || "sandbox",
      image,
      resources: resources(env),
    };
  }
  if (kind === "local") {
    return { kind, root: required(env, "BOTS_REGULAR_LOCAL_ROOT"), agent: required(env, "BOTS_REGULAR_LOCAL_AGENT").split(" ") };
  }
  throw new Error("BOTS_REGULAR_PROVIDER must be gke or local");
}

export function regularConfig(env: Env): RegularConfig {
  const serviceSecret = required(env, "BOTS_REGULAR_SERVICE_SECRET");
  if (serviceSecret.length < MIN_SERVICE_SECRET_CHARS) {
    throw new Error("BOTS_REGULAR_SERVICE_SECRET must be a unique 256-bit secret (openssl rand -hex 32)");
  }
  const list = (env.BOTS_TEST_ACCOUNTS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const gatewayOrigin = required(env, "BOTS_REGULAR_GATEWAY_ORIGIN");
  if (!/^http:\/\/[a-z0-9.-]+(:\d+)?$/.test(gatewayOrigin)) throw new Error("BOTS_REGULAR_GATEWAY_ORIGIN must be http://<host>[:port]");
  const policy = env.BOTS_UNARCHIVED_HISTORY_POLICY ?? "notice-then-expiry-30-days";
  if (policy !== "notice-then-expiry-30-days") throw new Error("BOTS_UNARCHIVED_HISTORY_POLICY must be notice-then-expiry-30-days");
  return {
    port: int(env, "PORT", 8080),
    serviceSecret,
    accounts: list.includes("*") ? "*" : new Set(list),
    model: env.BOTS_MODEL?.trim() || DEFAULT_MODEL,
    idleMs: int(env, "BOTS_IDLE_MS", 5 * 60_000, 1000),
    dataRoot: env.BOTS_DATA_ROOT ?? "/data/bots",
    runRoot: env.BOTS_RUN_ROOT ?? "/run/bots",
    maxRunning: int(env, "BOTS_MAX_RUNNING", 4),
    turnTimeoutMs: int(env, "BOTS_TURN_TIMEOUT_MS", 5 * 60_000, 1000),
    maxTurnBytes: int(env, "BOTS_MAX_TURN_BYTES", 256 * 1024, 1024),
    retentionDays: int(env, "BOTS_RETENTION_DAYS", 30),
    startTimeoutMs: int(env, "BOTS_REGULAR_START_TIMEOUT_MS", 3 * 60_000, 1000),
    touchMs: int(env, "BOTS_REGULAR_TOUCH_MS", 60_000, 100),
    gatewayControlSocket: env.BOTS_REGULAR_GATEWAY_CONTROL_SOCKET ?? "/run/gateway/control.sock",
    gatewayOrigin,
    provider: provider(env),
    history: env.BOTS_HISTORY_ENABLED === "true" ? {
      signerDid: required(env, "BOTS_HISTORY_SIGNER_DID"),
      host: required(env, "BOTS_HISTORY_NODE_ORIGIN"),
      policy,
    } : undefined,
  };
}
