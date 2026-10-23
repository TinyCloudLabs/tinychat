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
import {
  ACTIVE_RUN_TTL_MS,
  SOURCES_BY_CAPABILITY,
  acquireSourceLock,
  attachEntry,
  clearEntry,
  evaluateStart,
  limitRefusal,
  releaseSourceLock,
  snapshotOf,
  stampEntry,
  type ExoLedgerEntry,
  type ExoStartGate,
  type ExoSourceGate,
  type ExoStartResult,
  type SourceLock,
} from "./ledger-model.js";

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
/** Wakes that may coalesce onto one active run. */
const ATTACH_LIMIT = 20;
/** Seconds quoted as `retryAfterSec` on a rate-limited or budget-exhausted record. */
const RETRY_AFTER_SEC = 60;

const OWNER_DID_RE = /^did:pkh:eip155:[0-9]+:(0x[0-9a-fA-F]{40})$/;
export const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type CooldownRule = { minIntervalMs: (hasFirefliesWebhook: boolean) => number; dailyCap: number };

/** TC-1013 D9, per source. `sync-meetings` has no rule of its own: `runWake` limits a meetings run by each source's rule. */
const COOLDOWN_RULES: Partial<Record<ExoCapability, CooldownRule>> = {
  "sync-fireflies": { minIntervalMs: (webhook) => (webhook ? 6 * HOUR_MS : HOUR_MS), dailyCap: 150 },
  "sync-google": { minIntervalMs: () => 30 * MINUTE_MS, dailyCap: 300 },
};

/** The start gate for one capability: its own rule, or none. */
function gateFor(capability: ExoCapability, hasWebhook: boolean): ExoStartGate {
  const rule = COOLDOWN_RULES[capability];
  return rule ? { dailyCap: rule.dailyCap, minIntervalMs: rule.minIntervalMs(hasWebhook) } : {};
}

/** The pre-check refusal from a read-only snapshot. `recordStart` repeats the check atomically before the start. */
function startRefusalOf(snapshot: ExoLedgerSnapshot, gate: ExoStartGate, now: number): { code: "budget_exhausted" | "rate_limited"; retryAfterSec: number } | undefined {
  if (gate.dailyCap !== undefined && snapshot.startsToday >= gate.dailyCap) {
    const nextDay = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
    return { code: "budget_exhausted", retryAfterSec: Math.ceil((nextDay - now) / 1000) };
  }
  if (gate.minIntervalMs !== undefined && snapshot.lastStartedAt !== undefined) {
    const readyAt = snapshot.lastStartedAt + gate.minIntervalMs;
    if (now < readyAt) return { code: "rate_limited", retryAfterSec: Math.ceil((readyAt - now) / 1000) };
  }
  return undefined;
}

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
  /**
   * Starts a run only when the gate admits it. Takes the capability's source locks first. Each `sourceGates` entry is
   * checked against its own entry before any write, then stamped on admission. A refusal frees the locks and writes nothing.
   */
  recordStart(owner: string, capability: ExoCapability, jobId: string, now: number, gate: ExoStartGate, sourceGates?: readonly ExoSourceGate[]): Promise<ExoStartResult>;
  /** Adds a coalesced wake to the active run. */
  attach(owner: string, capability: ExoCapability, jobId: string): Promise<void>;
  /** Clears the active run only when it is `jobId`. Returns the wakes attached to it. */
  clearActive(owner: string, capability: ExoCapability, jobId: string): Promise<string[]>;
  /** Holds a job record whose store write failed, so a restart still sees the outcome. */
  holdJob(owner: string, jobId: string, record: ExoJobRecord): Promise<void>;
  /** The record held for a job, or undefined. */
  heldJob(owner: string, jobId: string): Promise<unknown>;
  /** Clears the held record for a job once its store write succeeds. */
  releaseJob(owner: string, jobId: string): Promise<void>;
  /** Job ids with a held record for the owner. */
  heldJobIds(owner: string): Promise<string[]>;
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
 * Records whose store write failed and whose ledger hold failed too. Process-only: lost on restart. Read like a ledger
 * hold and retired by a later successful write.
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

/** The held copy for a job: the process copy when the ledger refused the hold, else the ledger copy. */
async function heldJobOf(ports: ExoMailboxPorts, owner: string, jobId: string): Promise<ExoJobRecord | undefined> {
  return parseJobRecord(heldRecords(ports.jobs).get(`${owner}|${jobId}`) ?? (await ports.ledger.heldJob(owner, jobId)));
}

/** The held copy when it is at least as new as the stored copy. A stale held copy never overrides a newer stored one. */
function newerRecord(held: ExoJobRecord | undefined, stored: ExoJobRecord | undefined): ExoJobRecord | undefined {
  if (!held) return stored;
  if (!stored) return held;
  return Date.parse(held.updatedAt) >= Date.parse(stored.updatedAt) ? held : stored;
}

/** Reads a job. A held copy wins when it is at least as new as the stored one. */
async function readJob(ports: ExoMailboxPorts, owner: string, jobId: string): Promise<unknown> {
  const stored = await ports.jobs.get(owner, jobId);
  return newerRecord(await heldJobOf(ports, owner, jobId), parseJobRecord(stored)) ?? stored;
}

/**
 * Writes a held copy that is newer than the stored copy back to the store. Replays call this first, so a terminal
 * state held before a restart reaches the store. A copy the store still refuses stays held.
 */
async function repairJob(ports: ExoMailboxPorts, owner: string, jobId: string): Promise<void> {
  const held = await heldJobOf(ports, owner, jobId);
  if (!held) return;
  const stored = parseJobRecord(await ports.jobs.get(owner, jobId));
  if (newerRecord(held, stored) === held) await writeJob(ports, owner, jobId, held);
}

/**
 * Writes back every held copy for an owner, not only the replayed job. A restarted process does not know which jobs
 * were held, so any verified wake for the owner repairs all of them.
 */
async function repairHeldJobs(ports: ExoMailboxPorts, owner: string): Promise<void> {
  const prefix = `${owner}|`;
  const ids = new Set(await ports.ledger.heldJobIds(owner));
  for (const key of heldRecords(ports.jobs).keys()) {
    if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  for (const jobId of ids) await repairJob(ports, owner, jobId);
}

/**
 * Writes a job. A failed store write is held in the ledger, so a restart still sees the outcome. If the hold also
 * fails, the record is kept in process. Neither path throws; failures are logged without the payload. A successful
 * store write retires any held copy.
 */
async function writeJob(ports: ExoMailboxPorts, owner: string, jobId: string, record: ExoJobRecord): Promise<void> {
  const held = heldRecords(ports.jobs);
  const key = `${owner}|${jobId}`;
  try {
    await ports.jobs.put(owner, jobId, record);
  } catch {
    console.error("[exo] job write failed; record held");
    try {
      await ports.ledger.holdJob(owner, jobId, record);
      held.delete(key);
    } catch {
      console.error("[exo] held record write failed; record kept in process");
      held.set(key, record);
    }
    return;
  }
  held.delete(key);
  await ports.ledger.releaseJob(owner, jobId).catch(() => {
    console.error("[exo] held record release failed; a stale copy is shadowed by newer stored records");
  });
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
    // An inactive owner stops before the request read. The wake runs after the 202 is sent (see
    // wake-intake.ts), so the HTTP response does not depend on how many reads this takes.
    if (!(await ports.grants.isActive(wake.owner))) return undefined;
    const capability = await findRequestCapability(ports.requests, wake.owner, wake.requestId);
    return capability ? { owner: wake.owner, requestId: wake.requestId, capability } : undefined;
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

  // Replay: the job id is the request id. Any verified wake first writes back the owner's held copies, so a terminal
  // state held before a restart reaches the store. A replay then changes nothing except settling a stale pending job.
  await repairHeldJobs(ports, owner);
  const existingRaw = await readJob(ports, owner, requestId);
  if (existingRaw !== undefined) {
    const existing = parseJobRecord(existingRaw);
    // A pending job past the active-run TTL that no live run accounts for has no run behind it. Settle it so replays do not stay pending.
    if (existing?.state === "pending" && now - Date.parse(existing.createdAt) > ACTIVE_RUN_TTL_MS) {
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
    if (snapshot.activeSince !== undefined && now - snapshot.activeSince > ACTIVE_RUN_TTL_MS) {
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

  // One lookup per wake: the Fireflies webhook changes the minimum interval.
  const hasWebhook = (capability === "sync-fireflies" || capability === "sync-meetings") && (await ports.connectors.hasFirefliesWebhook(owner));
  const gate = gateFor(capability, hasWebhook);
  // A meetings run reads both sources, so each source's own rule limits it. The ledger checks and stamps them with the start.
  const sourceGates: ExoSourceGate[] =
    capability === "sync-meetings" ? (["sync-fireflies", "sync-google"] as const).map((source) => ({ capability: source, gate: gateFor(source, hasWebhook) })) : [];
  const checks: Array<{ capability: ExoCapability; gate: ExoStartGate }> = [
    ...(COOLDOWN_RULES[capability] ? [{ capability, gate }] : []),
    ...sourceGates,
  ];
  for (const check of checks) {
    const checked = check.capability === capability ? snapshot : await ports.ledger.snapshot(owner, check.capability, now);
    const refusal = startRefusalOf(checked, check.gate, now);
    if (refusal) {
      await createJob(ports, wake, newJob(wake, timestamp, "error", refusal.code, { retryAfterSec: refusal.retryAfterSec }));
      return;
    }
  }

  const job = newJob(wake, timestamp, "pending", "accepted");
  if (!(await createJob(ports, wake, job))) return;
  // The gate runs inside the ledger's conditional write. A refusal is a lost race or a limit reached since the snapshot.
  const decision = await ports.ledger.recordStart(owner, capability, requestId, now, gate, sourceGates).catch((): undefined => undefined);
  if (decision === undefined) {
    // The job is stored pending before the ledger write. Settle it in process so replays and this request id do not stay pending.
    const failed: ExoJobRecord = { ...job, state: "error", code: "unavailable", message: JOB_MESSAGE.unavailable, updatedAt: timestamp };
    await writeJob(ports, owner, requestId, failed);
    await ports.ledger.clearActive(owner, capability, requestId);
    return;
  }
  if (!decision.started) {
    const refused: ExoJobRecord =
      decision.reason === "budget"
        ? { ...job, state: "error", code: "budget_exhausted", message: JOB_MESSAGE.budget_exhausted, updatedAt: timestamp, retryAfterSec: Math.ceil(decision.retryAfterMs / 1000) }
        : decision.reason === "cooldown" || decision.reason === "source"
          ? { ...job, state: "error", code: "rate_limited", message: JOB_MESSAGE.rate_limited, updatedAt: timestamp, retryAfterSec: Math.ceil(decision.retryAfterMs / 1000) }
          : { ...job, state: "error", code: "rate_limited", message: JOB_MESSAGE.rate_limited, updatedAt: timestamp, retryAfterSec: RETRY_AFTER_SEC };
    await writeJob(ports, owner, requestId, refused);
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
 * Removes one expired job and its request record. The request goes first: if that removal throws, the job stays, so a
 * later replay of the request id finds the job and starts nothing. Removing the job first could leave a surviving request
 * with no job, and a replay would start the run again.
 */
export async function removeExpiredJob(
  ports: Pick<ExoMailboxPorts, "requests" | "ledger"> & { jobs: Pick<ExoJobStore, "remove"> },
  owner: string,
  jobId: string,
  capability: ExoCapability,
): Promise<void> {
  await ports.requests.remove(owner, requestPath(capability, jobId));
  await ports.jobs.remove(owner, jobId);
  // A held copy left behind has no request to replay, so a failed release here is harmless.
  await ports.ledger.releaseJob(owner, jobId).catch((): undefined => undefined);
}

/**
 * Deletes one owner's job records whose `updatedAt` is older than the retention window, with their request records.
 * Records that do not parse are kept. The scheduler that calls this is S4's.
 */
export async function sweepExpiredJobs(
  ports: Pick<ExoMailboxPorts, "requests" | "ledger"> & { jobs: Pick<ExoJobStore, "list" | "remove"> },
  owner: string,
  now: number,
  retentionMs: number = EXO_JOB_RETENTION_MS,
): Promise<number> {
  const cutoff = now - retentionMs;
  let removed = 0;
  for (const entry of await ports.jobs.list(owner)) {
    const job = parseJobRecord(entry.value);
    if (!job) continue;
    const updated = Date.parse(job.updatedAt);
    if (!Number.isFinite(updated) || updated > cutoff) continue;
    await removeExpiredJob(ports, owner, entry.jobId, job.capability);
    removed += 1;
  }
  return removed;
}

/** In-process ledger over the same gate and source-lock rules as the durable ledger. Not restart-durable. Used by tests only. */
export function createMemoryExoLedger(): ExoLedger {
  const entries = new Map<string, ExoLedgerEntry>();
  const locks = new Map<string, SourceLock>();
  const held = new Map<string, unknown>();
  const keyOf = (owner: string, capability: ExoCapability) => `${owner}|${capability}`;
  const lockKeyOf = (owner: string, source: ConnectorSource) => `${owner}|source|${source}`;
  const freeSourceLocks = (owner: string, sources: readonly ConnectorSource[], jobId: string) => {
    for (const source of sources) {
      const next = releaseSourceLock(locks.get(lockKeyOf(owner, source)), jobId);
      if (next) locks.set(lockKeyOf(owner, source), next);
    }
  };
  return {
    async snapshot(owner, capability, now) {
      return snapshotOf(entries.get(keyOf(owner, capability)), now);
    },
    async recordStart(owner, capability, jobId, now, gate, sourceGates = []) {
      const sources = SOURCES_BY_CAPABILITY[capability];
      const taken: ConnectorSource[] = [];
      for (const source of sources) {
        const step = acquireSourceLock(locks.get(lockKeyOf(owner, source)), jobId, capability, now);
        if (!step.acquired) {
          freeSourceLocks(owner, taken, jobId);
          return { started: false, reason: step.reason, retryAfterMs: step.retryAfterMs };
        }
        locks.set(lockKeyOf(owner, source), step.next);
        taken.push(source);
      }
      // Source limits are read before any write, as in the durable ledger.
      for (const source of sourceGates) {
        const refused = limitRefusal(entries.get(keyOf(owner, source.capability)), now, source.gate);
        if (refused) {
          freeSourceLocks(owner, sources, jobId);
          return refused;
        }
      }
      const key = keyOf(owner, capability);
      const decided = evaluateStart(entries.get(key), jobId, now, gate);
      if (decided.next) entries.set(key, decided.next);
      if (!decided.result.started) {
        freeSourceLocks(owner, sources, jobId);
        return decided.result;
      }
      for (const source of sourceGates) {
        const sourceKey = keyOf(owner, source.capability);
        entries.set(sourceKey, stampEntry(entries.get(sourceKey), now));
      }
      return decided.result;
    },
    async attach(owner, capability, jobId) {
      const key = keyOf(owner, capability);
      const next = attachEntry(entries.get(key), jobId);
      if (next) entries.set(key, next);
    },
    async clearActive(owner, capability, jobId) {
      freeSourceLocks(owner, SOURCES_BY_CAPABILITY[capability], jobId);
      const key = keyOf(owner, capability);
      const cleared = clearEntry(entries.get(key), jobId);
      if (cleared.next) entries.set(key, cleared.next);
      return cleared.released;
    },
    async holdJob(owner, jobId, record) {
      held.set(`${owner}|${jobId}`, record);
    },
    async heldJob(owner, jobId) {
      return held.get(`${owner}|${jobId}`);
    },
    async releaseJob(owner, jobId) {
      held.delete(`${owner}|${jobId}`);
    },
    async heldJobIds(owner) {
      const prefix = `${owner}|`;
      return [...held.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
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
