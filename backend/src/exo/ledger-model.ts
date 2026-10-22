import type { ConnectorSource, ExoCapability, ExoLedgerSnapshot } from "./mailbox.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ledger state for one owner and capability. One JSON value per key. */
export interface ExoLedgerEntry {
  /** UTC day index of the last start. */
  day: number;
  startsToday: number;
  lastStartedAt: number;
  activeJobId?: string;
  /** Present only with `activeJobId`. */
  activeSince?: number;
  /** Wakes coalesced onto the active run. Present only with `activeJobId`. */
  attachedJobIds: string[];
}

/** Limits applied atomically at the start write. An absent limit is not enforced. */
export interface ExoStartGate {
  dailyCap?: number;
  minIntervalMs?: number;
}

export type ExoStartResult =
  | { started: true }
  | { started: false; reason: "active" | "budget" | "cooldown" | "source"; retryAfterMs: number };

/** Read view of one entry. Pure. */
export function snapshotOf(entry: ExoLedgerEntry | undefined, now: number): ExoLedgerSnapshot {
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
}

/**
 * The start gate. Refuses while a run is active, past the daily cap, or inside the cooldown. The caller writes
 * `next` only when the result is `started`, in the same conditional write that read `entry`.
 */
export function evaluateStart(
  entry: ExoLedgerEntry | undefined,
  jobId: string,
  now: number,
  gate: ExoStartGate,
): { result: ExoStartResult; next?: ExoLedgerEntry } {
  if (entry?.activeJobId !== undefined) return { result: { started: false, reason: "active", retryAfterMs: 0 } };
  const today = Math.floor(now / DAY_MS);
  const startsToday = entry !== undefined && entry.day === today ? entry.startsToday : 0;
  if (gate.dailyCap !== undefined && startsToday >= gate.dailyCap) {
    return { result: { started: false, reason: "budget", retryAfterMs: (today + 1) * DAY_MS - now } };
  }
  if (gate.minIntervalMs !== undefined && entry !== undefined) {
    const readyAt = entry.lastStartedAt + gate.minIntervalMs;
    if (now < readyAt) return { result: { started: false, reason: "cooldown", retryAfterMs: readyAt - now } };
  }
  return {
    result: { started: true },
    next: {
      day: today,
      startsToday: startsToday + 1,
      lastStartedAt: now,
      activeJobId: jobId,
      activeSince: now,
      attachedJobIds: [],
    },
  };
}

/** Adds a coalesced wake to the active run. Undefined when no run is active, so nothing is written. */
export function attachEntry(entry: ExoLedgerEntry | undefined, jobId: string): ExoLedgerEntry | undefined {
  if (entry === undefined || entry.activeJobId === undefined) return undefined;
  return { ...entry, attachedJobIds: [...entry.attachedJobIds, jobId] };
}

/** Clears the active run only when it is `jobId`. `next` is undefined when nothing changes. */
export function clearEntry(entry: ExoLedgerEntry | undefined, jobId: string): { released: string[]; next?: ExoLedgerEntry } {
  if (entry === undefined || entry.activeJobId !== jobId) return { released: [] };
  return {
    released: [...entry.attachedJobIds],
    next: {
      day: entry.day,
      startsToday: entry.startsToday,
      lastStartedAt: entry.lastStartedAt,
      attachedJobIds: [],
    },
  };
}

/** Validates a stored value. Throws on any shape mismatch so a corrupt row fails closed. */
export function parseLedgerEntry(value: unknown): ExoLedgerEntry {
  if (value === null || typeof value !== "object") throw new Error("Exo ledger entry invalid");
  const v = value as Record<string, unknown>;
  const day = v.day;
  const startsToday = v.startsToday;
  const lastStartedAt = v.lastStartedAt;
  const attached = v.attachedJobIds;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  if (!finite(day) || !finite(startsToday) || !finite(lastStartedAt)) throw new Error("Exo ledger entry invalid");
  if (!Array.isArray(attached) || !attached.every((id) => typeof id === "string")) throw new Error("Exo ledger entry invalid");
  const entry: ExoLedgerEntry = { day, startsToday, lastStartedAt, attachedJobIds: attached as string[] };
  if (v.activeJobId !== undefined) {
    if (typeof v.activeJobId !== "string") throw new Error("Exo ledger entry invalid");
    entry.activeJobId = v.activeJobId;
  }
  if (v.activeSince !== undefined) {
    if (!finite(v.activeSince)) throw new Error("Exo ledger entry invalid");
    entry.activeSince = v.activeSince;
  }
  return entry;
}

/** A run that has not reported within this window is settled as unavailable, and its source locks become stealable. */
export const ACTIVE_RUN_TTL_MS = 30 * 60 * 1000;

/** Connector sources each capability reads. Source locks are taken in this order. */
export const SOURCES_BY_CAPABILITY: Record<ExoCapability, readonly ConnectorSource[]> = {
  "sync-meetings": ["fireflies", "google"],
  "sync-fireflies": ["fireflies"],
  "sync-google": ["google"],
};

/**
 * Lock on one connector source for one owner. `holder` absent means free. Two capabilities that read the same source
 * cannot run it at once. A lock held past ACTIVE_RUN_TTL_MS is stealable, so a crashed run cannot block a source forever.
 */
export interface SourceLock {
  holder?: string;
  capability: ExoCapability;
  acquiredAt: number;
}

export type SourceLockStep =
  | { acquired: true; next: SourceLock }
  | { acquired: false; reason: "active" | "source"; retryAfterMs: number };

/**
 * Takes a free, stale, or already-held-by-`jobId` lock. A lock held by another run of the same capability means the
 * capability is already active. A lock held by another capability means the source is busy.
 */
export function acquireSourceLock(current: SourceLock | undefined, jobId: string, capability: ExoCapability, now: number): SourceLockStep {
  if (current !== undefined && current.holder !== undefined && current.holder !== jobId && now - current.acquiredAt < ACTIVE_RUN_TTL_MS) {
    if (current.capability === capability) return { acquired: false, reason: "active", retryAfterMs: 0 };
    return { acquired: false, reason: "source", retryAfterMs: current.acquiredAt + ACTIVE_RUN_TTL_MS - now };
  }
  return { acquired: true, next: { holder: jobId, capability, acquiredAt: now } };
}

/** Frees the lock only when `jobId` holds it. Undefined when nothing changes. */
export function releaseSourceLock(current: SourceLock | undefined, jobId: string): SourceLock | undefined {
  if (current === undefined || current.holder !== jobId) return undefined;
  return { capability: current.capability, acquiredAt: current.acquiredAt };
}

/** Validates a stored lock. Throws on any shape mismatch so a corrupt lock fails closed. */
export function parseSourceLock(value: unknown): SourceLock {
  if (value === null || typeof value !== "object") throw new Error("Exo source lock invalid");
  const v = value as Record<string, unknown>;
  const { holder, capability, acquiredAt } = v;
  if (typeof capability !== "string" || !Object.keys(SOURCES_BY_CAPABILITY).includes(capability)) throw new Error("Exo source lock invalid");
  if (typeof acquiredAt !== "number" || !Number.isFinite(acquiredAt)) throw new Error("Exo source lock invalid");
  if (holder !== undefined && typeof holder !== "string") throw new Error("Exo source lock invalid");
  const lock: SourceLock = { capability: capability as ExoCapability, acquiredAt };
  if (holder !== undefined) lock.holder = holder;
  return lock;
}
