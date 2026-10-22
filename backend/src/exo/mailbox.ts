/**
 * Exo capability mailbox (TC-1013 S3, backend side).
 *
 * The agent writes a content-free request record into the owner's space and posts a wake
 * `{owner, requestId}`. This module validates the wake, checks the owner's verified grant,
 * applies the connector gate and per-source cooldowns, and mirrors job state into the owner's
 * space. Every dependency is an injected port. The default wiring fails closed.
 */
import { APP_ID } from "@tinyboilerplate/core";

export const EXO_CAPABILITIES = ["sync-meetings", "sync-fireflies", "sync-google"] as const;
export type ExoCapability = (typeof EXO_CAPABILITIES)[number];

export const EXO_JOB_STATES = ["pending", "running", "done", "error"] as const;
export type ExoJobState = (typeof EXO_JOB_STATES)[number];

export type ConnectorSource = "fireflies" | "google";

export const EXO_NAMESPACE = `${APP_ID}/exo/v1`;
export const EXO_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EXO_UNAVAILABLE_BODY = { error: "exo_sync_unavailable" } as const;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SOURCES_BY_CAPABILITY: Record<ExoCapability, readonly ConnectorSource[]> = {
  "sync-meetings": ["fireflies", "google"],
  "sync-fireflies": ["fireflies"],
  "sync-google": ["google"],
};

type CooldownRule = { minIntervalMs: (hasFirefliesWebhook: boolean) => number; dailyCap: number };

/** TC-1013 D9, per source. `sync-meetings` has no entry: each source a meetings run uses is limited on its own. */
const COOLDOWN_RULES: Partial<Record<ExoCapability, CooldownRule>> = {
  "sync-fireflies": { minIntervalMs: (webhook) => (webhook ? 6 * HOUR_MS : HOUR_MS), dailyCap: 150 },
  "sync-google": { minIntervalMs: () => 30 * MINUTE_MS, dailyCap: 300 },
};

export interface ExoJobRecord {
  v: 1;
  jobId: string;
  capability: ExoCapability;
  state: ExoJobState;
  code?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorSwitch {
  /** Connector server-sync switch for this owner and source. Must default to off. */
  isOn(owner: string, source: ConnectorSource): Promise<boolean>;
  /** Whether a Fireflies webhook is active for the owner. Selects the 6 h cooldown instead of 1 h. */
  hasFirefliesWebhook(owner: string): Promise<boolean>;
}

export interface ExecutorUpdate {
  state: "running" | "done" | "error";
  code?: string;
  message?: string;
}

export interface SyncExecutor {
  /** Starts the sync for a pending job. Reports state changes through `report`. */
  start(job: ExoJobRecord, report: (update: ExecutorUpdate) => Promise<void>): Promise<void>;
}

export interface ExoJobStore {
  /** Returns the raw stored value, or undefined when the job is absent. */
  get(owner: string, jobId: string): Promise<unknown>;
  /** Writes only if absent. Returns false when a record already exists. */
  putIfAbsent(owner: string, jobId: string, record: ExoJobRecord): Promise<boolean>;
  put(owner: string, jobId: string, record: ExoJobRecord): Promise<void>;
  list(owner: string): Promise<Array<{ jobId: string; value: unknown }>>;
  remove(owner: string, jobId: string): Promise<void>;
}

export interface ExoLedgerSnapshot {
  lastStartedAt?: number;
  startsToday: number;
  activeJobId?: string;
}

/** Cooldown, daily-cap and coalescing state per owner and capability. */
export interface ExoLedger {
  snapshot(owner: string, capability: ExoCapability, now: number): Promise<ExoLedgerSnapshot>;
  recordStart(owner: string, capability: ExoCapability, jobId: string, now: number): Promise<void>;
  clearActive(owner: string, capability: ExoCapability, jobId: string): Promise<void>;
}

export interface ExoMailboxPorts {
  grants: { isActive(owner: string): Promise<boolean> };
  /** Returns the raw stored value at a kv path, or undefined when absent. */
  requests: { get(owner: string, path: string): Promise<unknown> };
  jobs: ExoJobStore;
  connectors: ConnectorSwitch;
  /** Absent means nothing can run. Wake is refused before any job is created. */
  executor?: SyncExecutor;
  ledger: ExoLedger;
  now(): number;
  /** Origin used for the `link` of connector-gate responses. */
  frontendOrigin: string;
}

export type WakeResult =
  | { status: 202; body: { jobId: string; state: ExoJobState; code: string; statusKey: string } }
  | { status: 409; body: Record<string, string> }
  | { status: 429; body: { error: "rate_limited" | "budget_exhausted"; retryAfterSec: number } };

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/** Strict wake body: exactly `{owner, requestId}`. Anything else is `undefined`. */
export function parseWakeBody(body: unknown): { owner: string; requestId: string } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!hasExactKeys(body, ["owner", "requestId"])) return undefined;
  const { owner, requestId } = body as { owner: unknown; requestId: unknown };
  if (typeof owner !== "string" || !OWNER_RE.test(owner)) return undefined;
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return undefined;
  return { owner: owner.toLowerCase(), requestId };
}

/** Strict request record `{"v":1,"capability":"<cap>"}` at the path for `capability`. */
export function parseRequestRecord(value: unknown, capability: ExoCapability): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["v", "capability"])) return false;
  const record = value as { v: unknown; capability: unknown };
  return record.v === 1 && record.capability === capability;
}

const JOB_REQUIRED_KEYS = ["v", "jobId", "capability", "state", "createdAt", "updatedAt"] as const;
const JOB_OPTIONAL_KEYS = ["code", "message"] as const;

/** Strict job record. Unknown keys, wrong types, or a bad state make the record unusable. */
export function parseJobRecord(value: unknown): ExoJobRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  const allowed = [...JOB_REQUIRED_KEYS, ...JOB_OPTIONAL_KEYS] as readonly string[];
  if (!JOB_REQUIRED_KEYS.every((key) => keys.includes(key))) return undefined;
  if (!keys.every((key) => allowed.includes(key))) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.jobId !== "string") return undefined;
  if (typeof record.capability !== "string" || !(EXO_CAPABILITIES as readonly string[]).includes(record.capability)) return undefined;
  if (typeof record.state !== "string" || !(EXO_JOB_STATES as readonly string[]).includes(record.state)) return undefined;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return undefined;
  if (record.code !== undefined && typeof record.code !== "string") return undefined;
  if (record.message !== undefined && typeof record.message !== "string") return undefined;
  return record as unknown as ExoJobRecord;
}

/** The wake's request id exists under exactly one capability path, and that record is valid. */
async function findRequestCapability(
  requests: ExoMailboxPorts["requests"],
  owner: string,
  requestId: string,
): Promise<ExoCapability | undefined> {
  const found: Array<{ capability: ExoCapability; value: unknown }> = [];
  for (const capability of EXO_CAPABILITIES) {
    const value = await requests.get(owner, `${EXO_NAMESPACE}/requests/${capability}/${requestId}`);
    if (value !== undefined) found.push({ capability, value });
  }
  if (found.length !== 1) return undefined;
  const [only] = found;
  return parseRequestRecord(only.value, only.capability) ? only.capability : undefined;
}

function acceptedBody(job: ExoJobRecord): WakeResult {
  return {
    status: 202,
    body: { jobId: job.jobId, state: job.state, code: job.code ?? "accepted", statusKey: `${EXO_NAMESPACE}/jobs/${job.jobId}` },
  };
}

function unavailable(): WakeResult {
  return { status: 409, body: { ...EXO_UNAVAILABLE_BODY } };
}

/** Handles a wake. Pre-verification refusals are one uniform 409 and reveal nothing. */
export async function handleWake(ports: ExoMailboxPorts, body: unknown): Promise<WakeResult> {
  const wake = parseWakeBody(body);
  if (!wake) return unavailable();
  const { owner, requestId } = wake;

  if (!(await ports.grants.isActive(owner))) return unavailable();
  const capability = await findRequestCapability(ports.requests, owner, requestId);
  if (!capability) return unavailable();

  // Replay: the job id is the request id. A replay returns the existing job, not an error.
  const existingRaw = await ports.jobs.get(owner, requestId);
  if (existingRaw !== undefined) {
    const existing = parseJobRecord(existingRaw);
    return existing ? acceptedBody(existing) : unavailable();
  }

  const executor = ports.executor;
  if (!executor) return unavailable();

  let anyOn = false;
  for (const source of SOURCES_BY_CAPABILITY[capability]) {
    if (await ports.connectors.isOn(owner, source)) {
      anyOn = true;
      break;
    }
  }
  if (!anyOn) {
    if (capability === "sync-meetings") {
      return { status: 409, body: { error: "connector_off", link: ports.frontendOrigin } };
    }
    return { status: 409, body: { error: "connector_off", source: SOURCES_BY_CAPABILITY[capability][0], link: ports.frontendOrigin } };
  }

  const now = ports.now();
  const snapshot = await ports.ledger.snapshot(owner, capability, now);

  if (snapshot.activeJobId !== undefined) {
    const active = parseJobRecord(await ports.jobs.get(owner, snapshot.activeJobId));
    if (active) return acceptedBody(active);
  }

  const rule = COOLDOWN_RULES[capability];
  if (rule) {
    if (snapshot.startsToday >= rule.dailyCap) {
      const nextDay = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
      return { status: 429, body: { error: "budget_exhausted", retryAfterSec: Math.ceil((nextDay - now) / 1000) } };
    }
    if (snapshot.lastStartedAt !== undefined) {
      const hasWebhook = capability === "sync-fireflies" && (await ports.connectors.hasFirefliesWebhook(owner));
      const readyAt = snapshot.lastStartedAt + rule.minIntervalMs(hasWebhook);
      if (now < readyAt) {
        return { status: 429, body: { error: "rate_limited", retryAfterSec: Math.ceil((readyAt - now) / 1000) } };
      }
    }
  }

  const timestamp = new Date(now).toISOString();
  const job: ExoJobRecord = { v: 1, jobId: requestId, capability, state: "pending", createdAt: timestamp, updatedAt: timestamp };
  if (!(await ports.jobs.putIfAbsent(owner, requestId, job))) {
    const raced = parseJobRecord(await ports.jobs.get(owner, requestId));
    return raced ? acceptedBody(raced) : unavailable();
  }
  await ports.ledger.recordStart(owner, capability, requestId, now);

  const report = async (update: ExecutorUpdate): Promise<void> => {
    const current = parseJobRecord(await ports.jobs.get(owner, requestId));
    if (!current) return;
    const next: ExoJobRecord = { ...current, state: update.state, updatedAt: new Date(ports.now()).toISOString() };
    if (update.code !== undefined) next.code = update.code;
    if (update.message !== undefined) next.message = update.message;
    await ports.jobs.put(owner, requestId, next);
    if (update.state === "done" || update.state === "error") {
      await ports.ledger.clearActive(owner, capability, requestId);
    }
  };

  void executor.start(job, report).catch(async () => {
    await report({ state: "error", code: "unavailable" });
  });

  return acceptedBody(job);
}

/**
 * Deletes one owner's job records whose `updatedAt` is older than the retention window.
 * Records that do not parse are kept. The scheduler that calls this is S4's.
 */
export async function sweepExpiredJobs(
  jobs: Pick<ExoJobStore, "list" | "remove">,
  owner: string,
  now: number,
  retentionMs: number = EXO_JOB_RETENTION_MS,
): Promise<number> {
  const cutoff = now - retentionMs;
  let removed = 0;
  for (const entry of await jobs.list(owner)) {
    const job = parseJobRecord(entry.value);
    if (!job) continue;
    const updated = Date.parse(job.updatedAt);
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    await jobs.remove(owner, entry.jobId);
    removed += 1;
  }
  return removed;
}

/** In-process ledger. Not durable: a restart resets cooldowns and coalescing. Durable ledger is S4. */
export function createMemoryExoLedger(): ExoLedger {
  const entries = new Map<string, { day: number; startsToday: number; lastStartedAt: number; activeJobId?: string }>();
  return {
    async snapshot(owner, capability, now) {
      const entry = entries.get(`${owner}|${capability}`);
      if (!entry) return { startsToday: 0 };
      const today = Math.floor(now / DAY_MS);
      const snapshot: ExoLedgerSnapshot = {
        startsToday: entry.day === today ? entry.startsToday : 0,
        lastStartedAt: entry.lastStartedAt,
      };
      if (entry.activeJobId !== undefined) snapshot.activeJobId = entry.activeJobId;
      return snapshot;
    },
    async recordStart(owner, capability, jobId, now) {
      const key = `${owner}|${capability}`;
      const today = Math.floor(now / DAY_MS);
      const previous = entries.get(key);
      const startsToday = previous && previous.day === today ? previous.startsToday : 0;
      entries.set(key, { day: today, startsToday: startsToday + 1, lastStartedAt: now, activeJobId: jobId });
    },
    async clearActive(owner, capability, jobId) {
      const entry = entries.get(`${owner}|${capability}`);
      if (entry && entry.activeJobId === jobId) entry.activeJobId = undefined;
    },
  };
}

/** Flag parse: exactly "true" enables. Empty or unset is off. Any other value is off with a warning. */
export function exoCapabilitiesEnabled(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): boolean {
  const raw = (env.EXO_CAPABILITIES_ENABLED ?? "").trim();
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  warn("[exo] EXO_CAPABILITIES_ENABLED must be 'true' or 'false'; capability mailbox stays off");
  return false;
}
