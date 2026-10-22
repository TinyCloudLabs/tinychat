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

/** Fixed text per job code. A job record carries one code and its matching message, nothing free-form. */
export const JOB_MESSAGE = {
  accepted: "Request accepted.",
  running: "Sync running.",
  done: "Sync complete.",
  unavailable: "Sync unavailable.",
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
  | { status: 202; body: { jobId: string; state: ExoJobState; code: ExoJobCode; statusKey: string } }
  | { status: 409; body: Record<string, string> }
  | { status: 429; body: { error: "rate_limited" | "budget_exhausted"; retryAfterSec: number } };

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

/** Strict wake body: exactly `{owner, requestId}`; owner is a `did:pkh:eip155` DID. Anything else is `undefined`. */
export function parseWakeBody(body: unknown): { owner: string; requestId: string } | undefined {
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

/** Strict job record: exactly these keys, a known capability, state, and code, and the fixed message for that code. */
export function parseJobRecord(value: unknown): ExoJobRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== JOB_KEYS.length || !JOB_KEYS.every((key) => keys.includes(key))) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1 || typeof record.jobId !== "string") return undefined;
  if (typeof record.capability !== "string" || !(EXO_CAPABILITIES as readonly string[]).includes(record.capability)) return undefined;
  if (typeof record.state !== "string" || !(EXO_JOB_STATES as readonly string[]).includes(record.state)) return undefined;
  if (typeof record.code !== "string" || !(EXO_JOB_CODES as readonly string[]).includes(record.code)) return undefined;
  if (record.message !== JOB_MESSAGE[record.code as ExoJobCode]) return undefined;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string") return undefined;
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
    body: { jobId: job.jobId, state: job.state, code: job.code, statusKey: `${EXO_NAMESPACE}/jobs/${job.jobId}` },
  };
}

function unavailable(): WakeResult {
  return { status: 409, body: { ...EXO_UNAVAILABLE_BODY } };
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
const EXECUTOR_MESSAGE: Record<ExecutorUpdate["code"], ExoJobMessage> = {
  running: JOB_MESSAGE.running,
  done: JOB_MESSAGE.done,
  unavailable: JOB_MESSAGE.unavailable,
};

/** Moves a non-terminal job to the update's state and code. Terminal records are never overwritten. */
async function settle(ports: ExoMailboxPorts, owner: string, jobId: string, update: ExecutorUpdate): Promise<void> {
  const current = parseJobRecord(await ports.jobs.get(owner, jobId));
  if (!current || current.state === "done" || current.state === "error") return;
  const valid = Object.hasOwn(EXECUTOR_STATES, update.state) && Object.hasOwn(EXECUTOR_MESSAGE, update.code);
  const next: ExecutorUpdate = valid ? update : { state: "error", code: "unavailable" };
  const updatedAt = new Date(ports.now()).toISOString();
  await ports.jobs.put(owner, jobId, {
    ...current,
    state: next.state,
    code: next.code,
    message: EXECUTOR_MESSAGE[next.code],
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
    await settle(ports, owner, runId, update);
    for (const jobId of attached) await settle(ports, owner, jobId, update);
    if (update.state === "done" || update.state === "error") {
      await ports.ledger.clearActive(owner, capability, runId);
    }
  });
}

/** A wake whose grant is active and whose request record verifies. */
export interface VerifiedWake {
  owner: string;
  requestId: string;
  capability: ExoCapability;
}

/** Verifies a wake: strict body, active grant, one valid request record. Any refusal is `undefined`. */
export async function verifyWake(ports: ExoMailboxPorts, body: unknown): Promise<VerifiedWake | undefined> {
  const wake = parseWakeBody(body);
  if (!wake) return undefined;
  const { owner, requestId } = wake;

  if (!(await ports.grants.isActive(owner))) return undefined;
  const capability = await findRequestCapability(ports.requests, owner, requestId);
  if (!capability) return undefined;
  return { owner, requestId, capability };
}

/** Starts or replays a verified wake. Everything runs in the owner lane, so two wakes cannot both see "no active run". */
export function startWake(ports: ExoMailboxPorts, wake: VerifiedWake): Promise<WakeResult> {
  const { owner, requestId, capability } = wake;
  return withOwnerLane(owner, async () => {
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
    const timestamp = new Date(now).toISOString();
    const snapshot = await ports.ledger.snapshot(owner, capability, now);

    if (snapshot.activeJobId !== undefined) {
      if (snapshot.activeSince !== undefined && now - snapshot.activeSince > EXO_ACTIVE_JOB_TTL_MS) {
        // A run that never reports is settled as unavailable so it cannot hold the capability.
        const released = await ports.ledger.clearActive(owner, capability, snapshot.activeJobId);
        for (const jobId of [snapshot.activeJobId, ...released]) {
          await settle(ports, owner, jobId, { state: "error", code: "unavailable" });
        }
      } else {
        const active = parseJobRecord(await ports.jobs.get(owner, snapshot.activeJobId));
        if (active) {
          if ((snapshot.attachedJobIds?.length ?? 0) >= ATTACH_LIMIT) {
            return { status: 429, body: { error: "rate_limited", retryAfterSec: 60 } };
          }
          // The coalesced wake keeps its own record and mirrors the run's state, code, and message.
          const attached: ExoJobRecord = { ...active, jobId: requestId, createdAt: timestamp, updatedAt: timestamp };
          if (!(await ports.jobs.putIfAbsent(owner, requestId, attached))) return unavailable();
          await ports.ledger.attach(owner, capability, requestId);
          return acceptedBody(attached);
        }
      }
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

    const job: ExoJobRecord = {
      v: 1,
      jobId: requestId,
      capability,
      state: "pending",
      code: "accepted",
      message: JOB_MESSAGE.accepted,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!(await ports.jobs.putIfAbsent(owner, requestId, job))) return unavailable();
    try {
      await ports.ledger.recordStart(owner, capability, requestId, now);
    } catch {
      // The job is stored pending before the ledger write. Settle it so replays and this request id do not stay pending.
      await settle(ports, owner, requestId, { state: "error", code: "unavailable" });
      await ports.ledger.clearActive(owner, capability, requestId);
      return acceptedBody({ ...job, state: "error", code: "unavailable", message: EXECUTOR_MESSAGE.unavailable });
    }

    // Not awaited, and started after the lane task returns. Each report settles or logs; none rejects into the executor.
    const reportSafely = (update: ExecutorUpdate) =>
      reportRun(ports, owner, capability, requestId, update).catch(() => console.error("[exo] job state update failed"));
    void Promise.resolve()
      .then(() => executor.start(job, reportSafely))
      .catch(() => reportSafely({ state: "error", code: "unavailable" }));

    return acceptedBody(job);
  });
}

/** Handles a wake. Pre-verification refusals are one uniform 409 and reveal nothing. */
export async function handleWake(ports: ExoMailboxPorts, body: unknown): Promise<WakeResult> {
  const wake = await verifyWake(ports, body);
  return wake ? startWake(ports, wake) : unavailable();
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
  const raw = (env.EXO_CAPABILITIES_ENABLED ?? "").trim();
  if (raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  warn("[exo] EXO_CAPABILITIES_ENABLED must be 'true' or 'false'; capability mailbox stays off");
  return false;
}
