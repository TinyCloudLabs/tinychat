/**
 * Exo capability mailbox (TC-1013 S3, backend side).
 *
 * The agent writes a content-free request record into the owner's space and posts a wake
 * `{owner, requestId}`. This module validates the wake, checks the owner's verified grant,
 * applies the connector gate and per-source cooldowns, and mirrors job state into the owner's
 * space. Every dependency is an injected port. The default wiring fails closed.
 */
import { APP_ID } from "@tinyboilerplate/core";
import type { FixedWindowBudget } from "./wake-intake.js";

export const EXO_CAPABILITIES = ["sync-meetings", "sync-fireflies", "sync-google"] as const;
export type ExoCapability = (typeof EXO_CAPABILITIES)[number];

export const EXO_JOB_STATES = ["pending", "running", "done", "error"] as const;
export type ExoJobState = (typeof EXO_JOB_STATES)[number];

export type ConnectorSource = "fireflies" | "google";

export const EXO_NAMESPACE = `${APP_ID}/exo/v1`;
export const EXO_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const EXO_UNAVAILABLE_BODY = { error: "exo_sync_unavailable" } as const;
/** The one reply for every owner- or record-dependent wake outcome. It carries nothing about stored requests. */
export const EXO_ACCEPTED_BODY = { status: "accepted" } as const;

/** Fixed text per job code. A job record carries one code and its matching message, nothing free-form. */
export const JOB_MESSAGE = {
  accepted: "Request accepted.",
  running: "Sync running.",
  done: "Sync complete.",
  unavailable: "Sync unavailable.",
  connector_off: "Connector is off.",
  needs_renewal: "Access needs renewal.",
  needs_reconnect: "Connector needs reconnecting.",
  storage_full: "Storage is full.",
  rate_limited: "Rate limited. Retry later.",
  budget_exhausted: "Daily limit reached. Retry later.",
} as const;
export type ExoJobCode = keyof typeof JOB_MESSAGE;
export type ExoJobMessage = (typeof JOB_MESSAGE)[ExoJobCode];
const EXO_JOB_CODES = Object.keys(JOB_MESSAGE) as ExoJobCode[];

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A run that has not reported within this window is settled as unavailable so it cannot hold the capability. */
export const EXO_ACTIVE_JOB_TTL_MS = 30 * MINUTE_MS;
/** Wakes that may coalesce onto one active run. */
const ATTACH_LIMIT = 20;
/** Seconds quoted as `retryAfterSec` on a rate-limited or budget-exhausted record. */
const RETRY_AFTER_SEC = 60;

const OWNER_DID_RE = /^did:pkh:eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  code: ExoJobCode;
  message: ExoJobMessage;
  createdAt: string;
  updatedAt: string;
  /** Present with `connector_off`: the frontend origin where the connector is switched on. */
  link?: string;
  /** Present with `connector_off` on a single-source capability. */
  source?: ConnectorSource;
  /** Present with `rate_limited` and `budget_exhausted`: seconds until a retry can succeed. */
  retryAfterSec?: number;
}

export interface ConnectorSwitch {
  /** Connector server-sync switch for this owner and source. Must default to off. */
  isOn(owner: string, source: ConnectorSource): Promise<boolean>;
  /** Whether a Fireflies webhook is active for the owner. Selects the 6 h cooldown instead of 1 h. */
  hasFirefliesWebhook(owner: string): Promise<boolean>;
}

export interface ExecutorUpdate {
  state: "running" | "done" | "error";
  /** Fixed-vocabulary code only. The record's message is derived from it. */
  code: Exclude<ExoJobCode, "accepted">;
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
  /** When the active run started. Present only with `activeJobId`. */
  activeSince?: number;
  /** Wakes coalesced onto the active run. Present only with `activeJobId`. */
  attachedJobIds?: string[];
}

/** Cooldown, daily-cap, and coalescing state per owner and capability. */
export interface ExoLedger {
  snapshot(owner: string, capability: ExoCapability, now: number): Promise<ExoLedgerSnapshot>;
  recordStart(owner: string, capability: ExoCapability, jobId: string, now: number): Promise<void>;
  /** Adds a coalesced wake to the active run. */
  attach(owner: string, capability: ExoCapability, jobId: string): Promise<void>;
  /** Clears the active run only when it is `jobId`. Returns the wakes attached to it. */
  clearActive(owner: string, capability: ExoCapability, jobId: string): Promise<string[]>;
}

export interface ExoMailboxPorts {
  grants: { isActive(owner: string): Promise<boolean> };
  /** Returns the raw stored value at a kv path, or undefined when absent. */
  requests: {
    get(owner: string, path: string): Promise<unknown>;
    /** Deletes the record at a kv path. Called best-effort once the wake's job record exists; a failure never fails the job. */
    remove(owner: string, path: string): Promise<void>;
  };
  jobs: ExoJobStore;
  connectors: ConnectorSwitch;
  /** Absent means nothing can run. A verified wake then records `unavailable`. */
  executor?: SyncExecutor;
  ledger: ExoLedger;
  now(): number;
  /** Origin written as the `link` of `connector_off` records. */
  frontendOrigin: string;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/** A parsed wake body. The owner is lowercased by the parser. */
export interface ExoWakeRequest {
  owner: string;
  requestId: string;
}

/** Strict wake body: exactly `{owner, requestId}`; owner is a `did:pkh:eip155` DID. Anything else is `undefined`. */
export function parseWakeBody(body: unknown): ExoWakeRequest | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  if (!hasExactKeys(body, ["owner", "requestId"])) return undefined;
  const { owner, requestId } = body as { owner: unknown; requestId: unknown };
  const ownerMatch = typeof owner === "string" ? OWNER_DID_RE.exec(owner) : null;
  if (!ownerMatch) return undefined;
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return undefined;
  return { owner: ownerMatch[1].toLowerCase(), requestId };
}

/** Strict request record `{"v":1,"capability":"<cap>"}` at the path for `capability`. */
export function parseRequestRecord(value: unknown, capability: ExoCapability): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!hasExactKeys(value, ["v", "capability"])) return false;
  const record = value as { v: unknown; capability: unknown };
  return record.v === 1 && record.capability === capability;
}

const JOB_KEYS = ["v", "jobId", "capability", "state", "code", "message", "createdAt", "updatedAt"] as const;
const JOB_OPTIONAL_KEYS = ["link", "source", "retryAfterSec"] as const;

/**
 * Strict job record: the fixed keys plus any optional keys, a known capability, state, and code, the fixed message for
 * that code, and well-typed optional fields.
 */
export function parseJobRecord(value: unknown): ExoJobRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (!JOB_KEYS.every((key) => keys.includes(key))) return undefined;
  if (!keys.every((key) => (JOB_KEYS as readonly string[]).includes(key) || (JOB_OPTIONAL_KEYS as readonly string[]).includes(key))) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.jobId !== "string") return undefined;
  if (typeof record.capability !== "string" || !(EXO_CAPABILITIES as readonly string[]).includes(record.capability)) return undefined;
  if (typeof record.state !== "string" || !(EXO_JOB_STATES as readonly string[]).includes(record.state)) return undefined;
  if (typeof record.code !== "string" || !(EXO_JOB_CODES as readonly string[]).includes(record.code)) return undefined;
  if (record.message !== JOB_MESSAGE[record.code as ExoJobCode]) return undefined;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return undefined;
  if (record.link !== undefined && typeof record.link !== "string") return undefined;
  if (record.source !== undefined && record.source !== "fireflies" && record.source !== "google") return undefined;
  if (record.retryAfterSec !== undefined && !(Number.isInteger(record.retryAfterSec) && (record.retryAfterSec as number) > 0)) {
    return undefined;
  }
  return record as unknown as ExoJobRecord;
}

/** The kv path of a request record. */
function requestPath(capability: ExoCapability, requestId: string): string {
  return `${EXO_NAMESPACE}/requests/${capability}/${requestId}`;
}

/** The wake's request id exists under exactly one capability path, and that record is valid. */
async function findRequestCapability(
  requests: ExoMailboxPorts["requests"],
  owner: string,
  requestId: string,
): Promise<ExoCapability | undefined> {
  const found: Array<{ capability: ExoCapability; value: unknown }> = [];
  for (const capability of EXO_CAPABILITIES) {
    const value = await requests.get(owner, requestPath(capability, requestId));
    if (value !== undefined) found.push({ capability, value });
  }
  if (found.length !== 1) return undefined;
  const [only] = found;
  return parseRequestRecord(only.value, only.capability) ? only.capability : undefined;
}

/**
 * Per-owner serialization of wake check-and-start and of run reports. Covers this process only. A
 * multi-instance deployment needs a durable ledger with an atomic compare-and-set (S4).
 */
const ownerLanes = new Map<string, Promise<unknown>>();

function withOwnerLane<T>(owner: string, task: () => Promise<T>): Promise<T> {
  const run = (ownerLanes.get(owner) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);
  ownerLanes.set(owner, tail);
  void tail.then(() => {
    if (ownerLanes.get(owner) === tail) ownerLanes.delete(owner);
  });
  return run;
}

/** States and codes an executor may report. Anything else settles the job as an error with code unavailable. */
const EXECUTOR_STATES: Record<ExecutorUpdate["state"], true> = { running: true, done: true, error: true };
const EXECUTOR_CODES: ReadonlySet<string> = new Set(EXO_JOB_CODES.filter((code) => code !== "accepted"));

/** The update as stored. An out-of-vocabulary state or code settles as error with code unavailable. */
function normalizeUpdate(update: ExecutorUpdate): ExecutorUpdate {
  const valid = Object.hasOwn(EXECUTOR_STATES, update.state) && EXECUTOR_CODES.has(update.code);
  return valid ? update : { state: "error", code: "unavailable" };
}

/**
 * Records whose store write failed, held in process so replays still see the outcome. A later successful
 * write retires the entry. Not durable: after a restart the stored record stands and the replay TTL settles it.
 */
const heldByStore = new WeakMap<ExoJobStore, Map<string, ExoJobRecord>>();

function heldRecords(jobs: ExoJobStore): Map<string, ExoJobRecord> {
  let held = heldByStore.get(jobs);
  if (!held) {
    held = new Map();
    heldByStore.set(jobs, held);
  }
  return held;
}

/** Reads a job, preferring a record held after a failed write. */
async function readJob(ports: ExoMailboxPorts, owner: string, jobId: string): Promise<unknown> {
  return heldRecords(ports.jobs).get(`${owner}|${jobId}`) ?? (await ports.jobs.get(owner, jobId));
}

/**
 * Writes a job. A failed write does not throw: the record is held in process and the failure is logged without
 * its payload. A successful write retires any held copy.
 */
async function writeJob(ports: ExoMailboxPorts, owner: string, jobId: string, record: ExoJobRecord): Promise<void> {
  const held = heldRecords(ports.jobs);
  const key = `${owner}|${jobId}`;
  try {
    await ports.jobs.put(owner, jobId, record);
    held.delete(key);
  } catch {
    held.set(key, record);
    console.error("[exo] job write failed; record held in process");
  }
}

/** Moves a non-terminal job to the update's state and code. Terminal records are never overwritten. */
async function settle(ports: ExoMailboxPorts, owner: string, jobId: string, update: ExecutorUpdate): Promise<void> {
  const current = parseJobRecord(await readJob(ports, owner, jobId));
  if (!current || current.state === "done" || current.state === "error") return;
  const next = normalizeUpdate(update);
  const updatedAt = new Date(ports.now()).toISOString();
  await writeJob(ports, owner, jobId, {
    ...current,
    state: next.state,
    code: next.code,
    message: JOB_MESSAGE[next.code],
    updatedAt,
  });
}

/** A run's report updates the run and every wake attached to it. A terminal report releases the run. */
async function reportRun(
  ports: ExoMailboxPorts,
  owner: string,
  capability: ExoCapability,
  runId: string,
  update: ExecutorUpdate,
): Promise<void> {
  await withOwnerLane(owner, async () => {
    const snapshot = await ports.ledger.snapshot(owner, capability, ports.now());
    const attached = snapshot.activeJobId === runId ? (snapshot.attachedJobIds ?? []) : [];
    try {
      await settle(ports, owner, runId, update);
      for (const jobId of attached) await settle(ports, owner, jobId, update);
    } finally {
      // Released even when a read in settle failed. A job left unsettled is settled by the replay TTL.
      if (normalizeUpdate(update).state !== "running") await ports.ledger.clearActive(owner, capability, runId);
    }
  });
}

/** A wake whose grant is active and whose request record verifies. */
export interface VerifiedWake {
  owner: string;
  requestId: string;
  capability: ExoCapability;
}

/** Verifies a wake: active grant and one valid request record under the owner's path. Total: a refusal or a throw is `undefined`. */
export async function verifyWake(ports: ExoMailboxPorts, wake: { owner: string; requestId: string }): Promise<VerifiedWake | undefined> {
  try {
    // Both reads run for every wake, so a refused wake costs the same store reads, in the same order, as a verified one.
    const active = await ports.grants.isActive(wake.owner);
    const capability = await findRequestCapability(ports.requests, wake.owner, wake.requestId);
    return active && capability ? { owner: wake.owner, requestId: wake.requestId, capability } : undefined;
  } catch {
    console.error("[exo] wake verification unavailable");
    return undefined;
  }
}

type JobExtras = Partial<Pick<ExoJobRecord, "link" | "source" | "retryAfterSec">>;

/** A job record for a verified wake. The message is fixed per code. */
function newJob(wake: VerifiedWake, timestamp: string, state: ExoJobState, code: ExoJobCode, extra: JobExtras = {}): ExoJobRecord {
  return {
    v: 1,
    jobId: wake.requestId,
    capability: wake.capability,
    state,
    code,
    message: JOB_MESSAGE[code],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...extra,
  };
}

/**
 * Creates a job record only when none exists. Once the record exists, the wake's request record is consumed best-effort:
 * a failed delete is logged and never fails the job. A failed write is logged without its payload and returns false.
 */
async function createJob(ports: ExoMailboxPorts, wake: VerifiedWake, record: ExoJobRecord): Promise<boolean> {
  let created: boolean;
  try {
    created = await ports.jobs.putIfAbsent(wake.owner, record.jobId, record);
  } catch {
    console.error("[exo] job record not written");
    return false;
  }
  if (created) {
    try {
      await ports.requests.remove(wake.owner, requestPath(wake.capability, wake.requestId));
    } catch {
      console.error("[exo] request record not consumed");
    }
  }
  return created;
}

/**
 * Records a verified wake's outcome in the job record and returns nothing. The route answers EXO_ACCEPTED_BODY for every
 * outcome, so all state lives in the record. Runs in the owner lane so two wakes cannot both see "no active run".
 */
export function startWake(ports: ExoMailboxPorts, wake: VerifiedWake, budget: FixedWindowBudget): Promise<void> {
  return withOwnerLane(wake.owner, async () => {
    try {
      await runWake(ports, wake, budget);
    } catch {
      console.error("[exo] wake not recorded");
      await createJob(ports, wake, newJob(wake, new Date(ports.now()).toISOString(), "error", "unavailable"));
    }
  });
}

async function runWake(ports: ExoMailboxPorts, wake: VerifiedWake, budget: FixedWindowBudget): Promise<void> {
  const { owner, requestId, capability } = wake;
  const now = ports.now();
  const timestamp = new Date(now).toISOString();

  // Replay: the job id is the request id. A replay changes nothing except settling a stale pending job.
  const existingRaw = await readJob(ports, owner, requestId);
  if (existingRaw !== undefined) {
    const existing = parseJobRecord(existingRaw);
    // A pending job past the active-run TTL that no live run accounts for has no run behind it. Settle it so replays do not stay pending.
    if (existing?.state === "pending" && now - Date.parse(existing.createdAt) > EXO_ACTIVE_JOB_TTL_MS) {
      const ledgerState = await ports.ledger.snapshot(owner, capability, now);
      const live = ledgerState.activeJobId === requestId || (ledgerState.attachedJobIds ?? []).includes(requestId);
      if (!live) {
        await writeJob(ports, owner, requestId, { ...existing, state: "error", code: "unavailable", message: JOB_MESSAGE.unavailable, updatedAt: timestamp });
      }
    }
    return;
  }

  // The owner budget counts new job records only. Replays returned above, so they spend nothing.
  if (!budget.spend(owner.toLowerCase(), now)) {
    await createJob(ports, wake, newJob(wake, timestamp, "error", "rate_limited", { retryAfterSec: RETRY_AFTER_SEC }));
    return;
  }

  const executor = ports.executor;
  if (!executor) {
    await createJob(ports, wake, newJob(wake, timestamp, "error", "unavailable"));
    return;
  }

  let anyOn = false;
  for (const source of SOURCES_BY_CAPABILITY[capability]) {
    if (await ports.connectors.isOn(owner, source)) {
      anyOn = true;
      break;
    }
  }
  if (!anyOn) {
    // sync-meetings has no single source, so its refusal names none.
    const single = capability === "sync-meetings" ? {} : { source: SOURCES_BY_CAPABILITY[capability][0] };
    await createJob(ports, wake, newJob(wake, timestamp, "error", "connector_off", { link: ports.frontendOrigin, ...single }));
    return;
  }

  const snapshot = await ports.ledger.snapshot(owner, capability, now);

  if (snapshot.activeJobId !== undefined) {
    if (snapshot.activeSince !== undefined && now - snapshot.activeSince > EXO_ACTIVE_JOB_TTL_MS) {
      // A run that never reports is settled as unavailable so it cannot hold the capability.
      const released = await ports.ledger.clearActive(owner, capability, snapshot.activeJobId);
      for (const jobId of [snapshot.activeJobId, ...released]) {
        await settle(ports, owner, jobId, { state: "error", code: "unavailable" });
      }
    } else {
      const active = parseJobRecord(await readJob(ports, owner, snapshot.activeJobId));
      if (active) {
        if ((snapshot.attachedJobIds?.length ?? 0) >= ATTACH_LIMIT) {
          await createJob(ports, wake, newJob(wake, timestamp, "error", "rate_limited", { retryAfterSec: RETRY_AFTER_SEC }));
          return;
        }
        // The coalesced wake keeps its own record and mirrors the run's state, code, and message.
        const attached: ExoJobRecord = { ...active, jobId: requestId, createdAt: timestamp, updatedAt: timestamp };
        if (await createJob(ports, wake, attached)) await ports.ledger.attach(owner, capability, requestId);
        return;
      }
    }
  }

  const rule = COOLDOWN_RULES[capability];
  if (rule) {
    if (snapshot.startsToday >= rule.dailyCap) {
      const nextDay = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
      await createJob(ports, wake, newJob(wake, timestamp, "error", "budget_exhausted", { retryAfterSec: Math.ceil((nextDay - now) / 1000) }));
      return;
    }
    if (snapshot.lastStartedAt !== undefined) {
      const hasWebhook = capability === "sync-fireflies" && (await ports.connectors.hasFirefliesWebhook(owner));
      const readyAt = snapshot.lastStartedAt + rule.minIntervalMs(hasWebhook);
      if (now < readyAt) {
        await createJob(ports, wake, newJob(wake, timestamp, "error", "rate_limited", { retryAfterSec: Math.ceil((readyAt - now) / 1000) }));
        return;
      }
    }
  }

  const job = newJob(wake, timestamp, "pending", "accepted");
  if (!(await createJob(ports, wake, job))) return;
  try {
    await ports.ledger.recordStart(owner, capability, requestId, now);
  } catch {
    // The job is stored pending before the ledger write. Settle it in process so replays and this request id do not stay pending.
    const failed: ExoJobRecord = { ...job, state: "error", code: "unavailable", message: JOB_MESSAGE.unavailable, updatedAt: timestamp };
    await writeJob(ports, owner, requestId, failed);
    await ports.ledger.clearActive(owner, capability, requestId);
    return;
  }

  // Not awaited, and started after the lane task returns. Each report settles or logs; none rejects into the executor.
  const reportSafely = (update: ExecutorUpdate) =>
    reportRun(ports, owner, capability, requestId, update).catch(() => console.error("[exo] job state update failed"));
  void Promise.resolve()
    .then(() => executor.start(job, reportSafely))
    .catch(() => reportSafely({ state: "error", code: "unavailable" }));
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

/** In-process ledger. Not durable: a restart resets cooldowns, coalescing, and active runs. Durable ledger is S4. */
export function createMemoryExoLedger(): ExoLedger {
  type Entry = {
    day: number;
    startsToday: number;
    lastStartedAt: number;
    activeJobId?: string;
    activeSince?: number;
    attachedJobIds: string[];
  };
  const entries = new Map<string, Entry>();
  return {
    async snapshot(owner, capability, now) {
      const entry = entries.get(`${owner}|${capability}`);
      if (!entry) return { startsToday: 0 };
      const today = Math.floor(now / DAY_MS);
      const snapshot: ExoLedgerSnapshot = {
        startsToday: entry.day === today ? entry.startsToday : 0,
        lastStartedAt: entry.lastStartedAt,
      };
      if (entry.activeJobId !== undefined) {
        snapshot.activeJobId = entry.activeJobId;
        snapshot.activeSince = entry.activeSince;
        snapshot.attachedJobIds = [...entry.attachedJobIds];
      }
      return snapshot;
    },
    async recordStart(owner, capability, jobId, now) {
      const key = `${owner}|${capability}`;
      const today = Math.floor(now / DAY_MS);
      const previous = entries.get(key);
      const startsToday = previous && previous.day === today ? previous.startsToday : 0;
      entries.set(key, {
        day: today,
        startsToday: startsToday + 1,
        lastStartedAt: now,
        activeJobId: jobId,
        activeSince: now,
        attachedJobIds: [],
      });
    },
    async attach(owner, capability, jobId) {
      const entry = entries.get(`${owner}|${capability}`);
      if (entry?.activeJobId !== undefined) entry.attachedJobIds.push(jobId);
    },
    async clearActive(owner, capability, jobId) {
      const entry = entries.get(`${owner}|${capability}`);
      if (!entry || entry.activeJobId !== jobId) return [];
      const released = entry.attachedJobIds;
      entry.activeJobId = undefined;
      entry.activeSince = undefined;
      entry.attachedJobIds = [];
      return released;
    },
  };
}

/** Flag parse: exactly "true" enables. Empty or unset is off. Any other value is off with a warning. */
export function exoCapabilitiesEnabled(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): boolean {
  const raw = env.EXO_CAPABILITIES_ENABLED ?? "";
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  warn("[exo] EXO_CAPABILITIES_ENABLED must be 'true' or 'false'; capability mailbox stays off");
  return false;
}
