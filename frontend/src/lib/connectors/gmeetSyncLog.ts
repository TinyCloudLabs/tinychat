// The Google Meet sync's client-side log: what a user can copy into a bug
// report when a sync is slow or stuck, and the one progress percentage the
// dialog's bar shows.
//
// COUNTERS, STEP NAMES AND ERROR KINDS ONLY. Nothing here reads a progress
// `message`, an error `message`, a title, a participant or transcript text, so
// none of it can reach the output even when the engine's own strings carry
// store text. Every field is copied through an allow-list, not spread.
import type {
  GmeetSyncDiagnostics,
  GmeetSyncErrorKind,
  GmeetSyncProgress,
  GmeetSyncResult,
} from "./gmeetSync";

export type GmeetSyncStage = NonNullable<GmeetSyncProgress["stage"]>;

const STAGES: readonly GmeetSyncStage[] = ["meetings", "notes-listing", "notes", "saving"];
const ERROR_KINDS: readonly GmeetSyncErrorKind[] = ["auth", "forbidden", "rate-limited", "network", "storage"];

/** Most entries one log keeps; older middle entries are dropped first. */
export const GMEET_SYNC_LOG_MAX_ENTRIES = 200;
/** Oldest entries always kept, so the log still shows how the run began. */
const KEPT_HEAD = 20;

/** One row of the timeline. `tMs` is milliseconds since the run started. */
export interface GmeetSyncLogEntry {
  tMs: number;
  stage: GmeetSyncStage;
  meetingsChecked: number;
  meetingsTotal: number | null;
  notesDone: number | null;
  notesTotal: number | null;
  docsListed: number | null;
  docsMatched: number | null;
}

export type GmeetSyncLogResultKind = "ok" | GmeetSyncErrorKind | "stopped" | "unknown";

export interface GmeetSyncLogResult {
  kind: GmeetSyncLogResultKind;
  /** False when Finishing ended without a connector_state row; null when not reported. */
  connectionSaved: boolean | null;
  /** True when Notes were left to reconcile in the background. */
  notesDeferred: boolean;
}

/** How a deferred Notes reconcile ended: the error kind only, never its message. */
export interface GmeetSyncLogNotesOutcome {
  ok: boolean;
  errorKind: GmeetSyncErrorKind | null;
}

export interface GmeetSyncLog {
  generatedAt: string;
  build: string | null;
  timeline: GmeetSyncLogEntry[];
  /** Entries dropped from the timeline to stay within the cap. */
  droppedEntries: number;
  diagnostics: Record<string, number | string> | null;
  /** `phase_*_ms` copied out of the diagnostics, for a quick read. */
  phaseTimingsMs: Record<string, number> | null;
  result: GmeetSyncLogResult | null;
  /** Null while the deferred Notes reconcile has not settled (or was not deferred). */
  notesOutcome: GmeetSyncLogNotesOutcome | null;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Timeline row for one progress event. Reads counters and `stage` only. */
export function gmeetSyncLogEntry(progress: GmeetSyncProgress, tMs: number): GmeetSyncLogEntry {
  const stage = STAGES.includes(progress.stage as GmeetSyncStage) ? (progress.stage as GmeetSyncStage) : "meetings";
  return {
    tMs: Math.max(0, Math.round(tMs)),
    stage,
    meetingsChecked: count(progress.current) ?? 0,
    meetingsTotal: count(progress.total),
    notesDone: count(progress.notesDone),
    notesTotal: count(progress.notesTotal),
    docsListed: count(progress.docsListed),
    docsMatched: count(progress.docsMatched),
  };
}

const DIAGNOSTIC_STRING_VALUES: Record<string, readonly string[]> = {
  drive_mode: ["snapshot", "incremental", "stale_cursor_snapshot", "unavailable"],
  finishing_stalled_phase: ["none", "drive", "count", "diagnostics", "state_write"],
  finishing_recovery_write: ["none", "written", "failed", "skipped_pending_storage", "timed_out"],
};

/** Numbers pass; the three enum strings pass only as one of their known values. */
function sanitizeDiagnostics(diagnostics: GmeetSyncDiagnostics): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const [key, value] of Object.entries(diagnostics as unknown as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && DIAGNOSTIC_STRING_VALUES[key]?.includes(value)) out[key] = value;
  }
  return out;
}

/** Final outcome of one run: the error KIND, never its message. */
export function summarizeGmeetSyncResult(res: GmeetSyncResult): GmeetSyncLogResult {
  if (res.ok) {
    return {
      kind: res.data.aborted ? "stopped" : "ok",
      connectionSaved: true,
      notesDeferred: res.data.notesDeferred === true,
    };
  }
  return {
    kind: ERROR_KINDS.includes(res.error.kind) ? res.error.kind : "unknown",
    connectionSaved: typeof res.connectionSaved === "boolean" ? res.connectionSaved : null,
    notesDeferred: false,
  };
}

export interface GmeetSyncLogRecorder {
  record(progress: GmeetSyncProgress): void;
  setDiagnostics(diagnostics: GmeetSyncDiagnostics): void;
  setResult(result: GmeetSyncLogResult): void;
  setNotesOutcome(outcome: { ok: boolean; errorKind: GmeetSyncErrorKind | null }): void;
  /** The run's start clock reading, for the elapsed counter. */
  readonly startedAt: number;
  build(input: { generatedAt: Date; build?: string | null }): GmeetSyncLog;
}

/** One recorder per run. `now` is the clock seam (Date.now by default). */
export function createGmeetSyncLogRecorder(now: () => number = Date.now): GmeetSyncLogRecorder {
  const startedAt = now();
  const timeline: GmeetSyncLogEntry[] = [];
  let dropped = 0;
  let diagnostics: GmeetSyncDiagnostics | null = null;
  let result: GmeetSyncLogResult | null = null;
  let notesOutcome: GmeetSyncLogNotesOutcome | null = null;
  return {
    startedAt,
    record(progress) {
      const entry = gmeetSyncLogEntry(progress, now() - startedAt);
      const last = timeline[timeline.length - 1];
      if (last && sameCounters(last, entry)) return;
      timeline.push(entry);
      if (timeline.length > GMEET_SYNC_LOG_MAX_ENTRIES) {
        timeline.splice(KEPT_HEAD, 1);
        dropped++;
      }
    },
    setDiagnostics(next) { diagnostics = next; },
    setResult(next) { result = next; },
    setNotesOutcome(next) {
      notesOutcome = { ok: next.ok === true, errorKind: ERROR_KINDS.includes(next.errorKind as GmeetSyncErrorKind) ? next.errorKind : null };
    },
    build({ generatedAt, build }) {
      const clean = diagnostics ? sanitizeDiagnostics(diagnostics) : null;
      let phaseTimingsMs: Record<string, number> | null = null;
      if (clean) {
        phaseTimingsMs = {};
        for (const [key, value] of Object.entries(clean)) {
          if (/^phase_.+_ms$/.test(key) && typeof value === "number") phaseTimingsMs[key] = value;
        }
      }
      return {
        generatedAt: generatedAt.toISOString(),
        build: build?.trim() || null,
        timeline: timeline.map((entry) => ({ ...entry })),
        droppedEntries: dropped,
        diagnostics: clean,
        phaseTimingsMs,
        result: result ? { ...result } : null,
        notesOutcome: notesOutcome ? { ...notesOutcome } : null,
      };
    },
  };
}

function sameCounters(a: GmeetSyncLogEntry, b: GmeetSyncLogEntry): boolean {
  return a.stage === b.stage && a.meetingsChecked === b.meetingsChecked && a.meetingsTotal === b.meetingsTotal
    && a.notesDone === b.notesDone && a.notesTotal === b.notesTotal
    && a.docsListed === b.docsListed && a.docsMatched === b.docsMatched;
}

/**
 * One monotonic-in-time percentage from a progress event: meetings 0-40,
 * Drive listing 40-50 (duration unknown, so its midpoint), Notes 50-90, saving
 * 90-100. A caller keeps the running maximum so out-of-order stage resets
 * (a retry's first event, a joiner's late event) never move the bar backwards.
 */
export function gmeetSyncProgressPercent(progress: GmeetSyncProgress | null): number {
  if (progress === null) return 0;
  if (progress.type === "complete") return 100;
  switch (progress.stage) {
    case "saving":
      return 95;
    case "notes-listing":
      return 45;
    case "notes": {
      const total = count(progress.notesTotal);
      if (total === null || total <= 0) return 50;
      const done = Math.min(Math.max(count(progress.notesDone) ?? 0, 0), total);
      return 50 + Math.round((40 * done) / total);
    }
    default: {
      const total = count(progress.total);
      if (total === null) return 0;
      if (total <= 0) return 40;
      return Math.round((40 * Math.min(Math.max(progress.current, 0), total)) / total);
    }
  }
}
