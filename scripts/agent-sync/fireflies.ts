// Headless Fireflies sync for an agent host (TC-1192, stopgap until TC-1013).
//
// Runs the unchanged browser engine (`syncFireflies`, `FirefliesClient`, `connectorStore`) with:
//   - a TinyCloud session restored in-process from a `tc` CLI profile (writes; one space);
//   - the Fireflies key read through an installed named grant when present, or through the
//     secrets-only profile otherwise; the key stays in memory;
//   - a counting `fetch` that caps upstream HTTP requests per run and per UTC day;
//   - a store wrapper that remembers the rows this runner inserted, so it can delete its own
//     duplicate when a browser inserted the same meeting concurrently.
//
// Output is one JSON line of counts and codes. It never prints titles, ids, transcript text or
// the key. See docs plan samgbafa/tinycloud-dev#100 for the grant shape and the guards.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { FirefliesClient, defaultFirefliesClientOptions } from "../../frontend/src/lib/connectors/firefliesClient";
import * as connectorStore from "../../frontend/src/lib/connectors/connectorStore";
import { CONNECTORS_SQL_DB_NAME, type StoreResult } from "../../frontend/src/lib/connectors/connectorStore";
import { syncFireflies, type SyncStore } from "../../frontend/src/lib/connectors/firefliesSync";
import { isStorageFullError } from "../../frontend/src/lib/storageStatus";
import { hasNamedGrantFile, NAMED_GRANT_FILE, NamedGrantError, prepareFirefliesKeySource } from "./named-grant";

export const SOURCE = "fireflies";
export const MAX_REQUESTS_PER_RUN = 100;
export const MAX_REQUESTS_PER_DAY = 200;
export const MAX_RUNS_PER_DAY = 4;
export const BUSY_WINDOW_MS = 30 * 60 * 1000;
export const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
/** Gap-audit listing pages (25 meetings each) over the last GAP_WINDOW_MS. */
export const GAP_AUDIT_PAGES = 4;
export const RECHECK_INSERTED_MS = 24 * 60 * 60 * 1000;
export const GAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PENDING_IDS = 50;
const INITIAL_AUDIT_CURSOR = { skip: 0, anchor: null, anchorDate: null, previousNeighbor: null };

export type RunResult =
  | "synced"
  | "fresh"
  | "busy"
  | "capped"
  | "partial"
  | "locked"
  | "not_connected"
  | "needs_reconnect"
  | "needs_renewal"
  | "storage_full"
  | "error";

export interface RunReport {
  v: 1;
  key_source: "named" | "legacy";
  named_grant_cid: string | null;
  named_grant_expires_at: string | null;
  at: string;
  mode: "auto" | "now";
  result: RunResult;
  /** The engine's own outcome from the attempt record: ok | partial | error | running. */
  status: string | null;
  added: number;
  skipped: number;
  errors: number;
  httpRequests: number;
  requestsToday: number;
  runsToday: number;
  duplicateRowsRemoved: number;
  gapIds: number;
  requeued: number;
  /** False when the gap audit stopped before reaching the end of its 7-day window; null when it did not run. */
  gapAuditComplete: boolean | null;
  tableDeltas: Record<string, number>;
  schemaChanged: boolean;
  /** connector_state.last_synced_at: advances only on a complete reconcile (TC-979). */
  lastSyncedAt: string | null;
  /** The attempt record's last_attempt_at: when any writer last ran, complete or not. */
  lastRunAt: string | null;
  durationMs: number;
  detail?: string;
}

/** SQL the runner issues outside the engine. The real one is `sqlAuditPort`. */
export interface AuditPort {
  tables(): Promise<{ counts: Record<string, number>; schemaHash: string }>;
  /** Ids of every Fireflies row that shares `source_id` with row `id`, including itself. */
  siblingsOf(id: string): Promise<string[]>;
  deleteOwnRow(id: string): Promise<void>;
}

export interface RunnerState {
  day: string;
  runs: number;
  requests: number;
  inserted: { id: string; at: string }[];
  auditCursor?: { skip: number; anchor: string | null; anchorDate: number | string | null; previousNeighbor: string | null };
}

export interface RunDeps {
  tcw: TinyCloudWeb;
  readApiKey: () => Promise<string>;
  keySource?: "named" | "legacy";
  namedGrant?: { cid: string; expiresAt: string };
  audit: AuditPort;
  stateDir: string;
  mode: "auto" | "now";
  staleMs?: number;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  delayMs?: number;
  now?: () => Date;
}

class RunnerError extends Error {
  constructor(readonly result: RunResult, message: string) {
    super(message);
  }
}

function emptyReport(mode: RunDeps["mode"], at: Date, keySource: "named" | "legacy" = "legacy", namedGrant?: RunDeps["namedGrant"]): RunReport {
  return {
    v: 1, key_source: keySource, named_grant_cid: namedGrant?.cid ?? null, named_grant_expires_at: namedGrant?.expiresAt ?? null,
    at: at.toISOString(), mode, result: "error", status: null, added: 0, skipped: 0, errors: 0,
    httpRequests: 0, requestsToday: 0, runsToday: 0, duplicateRowsRemoved: 0, gapIds: 0, requeued: 0, gapAuditComplete: null,
    tableDeltas: {}, schemaChanged: false, lastSyncedAt: null, lastRunAt: null, durationMs: 0,
  };
}

// ── State and lock ──────────────────────────────────────────────────────

function readState(file: string, day: string): RunnerState {
  const fresh: RunnerState = { day, runs: 0, requests: 0, inserted: [] };
  if (!existsSync(file)) return fresh;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RunnerError("error", "invalid runner state");
  }
  if (!raw || typeof raw !== "object" || !("day" in raw) || typeof raw.day !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(raw.day)
    || !("runs" in raw) || !Number.isSafeInteger(raw.runs) || (raw.runs as number) < 0
    || !("requests" in raw) || !Number.isSafeInteger(raw.requests) || (raw.requests as number) < 0
    || !("inserted" in raw) || !Array.isArray(raw.inserted)
    || !raw.inserted.every((entry: unknown) => entry && typeof entry === "object"
      && "id" in entry && typeof entry.id === "string" && "at" in entry && typeof entry.at === "string")) {
    throw new RunnerError("error", "invalid runner state");
  }
  const cursor = "auditCursor" in raw ? raw.auditCursor : undefined;
  if (cursor !== undefined && (!cursor || typeof cursor !== "object"
    || !("skip" in cursor) || !Number.isSafeInteger(cursor.skip) || (cursor.skip as number) < 0
    || !("anchor" in cursor) || !(cursor.anchor === null || typeof cursor.anchor === "string")
    || !("anchorDate" in cursor) || !(cursor.anchorDate === null || typeof cursor.anchorDate === "string" || typeof cursor.anchorDate === "number")
    || !("previousNeighbor" in cursor) || !(cursor.previousNeighbor === null || typeof cursor.previousNeighbor === "string"))) {
    throw new RunnerError("error", "invalid runner state");
  }
  return {
    day, runs: raw.day === day ? raw.runs as number : 0,
    requests: raw.day === day ? raw.requests as number : 0,
    inserted: raw.inserted as RunnerState["inserted"],
    auditCursor: cursor as RunnerState["auditCursor"],
  };
}

function writeState(file: string, state: RunnerState): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * In-process guard against overlapping direct invocations. The host wrapper holds `flock` and
 * reclaims abandoned files; a standalone invocation never deletes another process's lock.
 */
function acquireLock(file: string): (() => void) | null {
  const token = `${process.pid} ${randomUUID()}`;
  try {
    const fd = openSync(file, "wx", 0o600);
    writeFileSync(fd, `${token}\n`);
    closeSync(fd);
    return () => {
      try {
        if (readFileSync(file, "utf8").trim() === token) rmSync(file, { force: true });
      } catch {
        // Already gone.
      }
    };
  } catch {
    return null;
  }
}

// ── Upstream request budget ─────────────────────────────────────────────

/** Counts every HTTP attempt, retries included; past the budget it answers 429 without calling out. */
export function countingFetch(
  inner: typeof fetch,
  budget: number,
  onRequest: () => void = () => undefined,
): { fetch: typeof fetch; used: () => number } {
  let used = 0;
  const counted = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (used >= budget) {
      // Retry-After above the client's 60 s ceiling makes it fail as rate-limited at once.
      return new Response("{}", { status: 429, headers: { "retry-after": "86400" } });
    }
    used++;
    onRequest();
    return inner(input, init);
  };
  // Object.assign carries over runtime statics such as Bun's fetch.preconnect.
  return { fetch: Object.assign(counted, inner), used: () => used };
}

// ── Run ─────────────────────────────────────────────────────────────────

export async function runFirefliesAgentSync(deps: RunDeps): Promise<RunReport> {
  const clock = deps.now ?? (() => new Date());
  const started = clock();
  const report = emptyReport(deps.mode, started, deps.keySource ?? "legacy", deps.namedGrant);
  const day = started.toISOString().slice(0, 10);
  mkdirSync(deps.stateDir, { recursive: true, mode: 0o700 });
  const stateFile = join(deps.stateDir, "fireflies-runner.json");
  const release = acquireLock(join(deps.stateDir, "fireflies.lock"));
  if (!release) return { ...report, result: "locked" };
  try {
    const state = readState(stateFile, day);
    report.runsToday = state.runs;
    report.requestsToday = state.requests;
    await runLocked(deps, report, state, clock, stateFile);
  } catch (error) {
    // Only fixed result codes reach the report.
    report.result = error instanceof RunnerError || error instanceof NamedGrantError ? error.result : "error";
    report.detail = error instanceof RunnerError || error instanceof NamedGrantError ? error.result : "unexpected_error";
  } finally {
    release();
    report.durationMs = clock().getTime() - started.getTime();
  }
  return report;
}

async function runLocked(
  deps: RunDeps,
  report: RunReport,
  state: RunnerState,
  clock: () => Date,
  stateFile: string,
): Promise<void> {
  const { tcw } = deps;
  const nowMs = clock().getTime();

  const connection = await connectorStore.getConnection(tcw, SOURCE);
  if (!connection.ok) throw new RunnerError(storeFailure(connection.error), `read connection: ${connection.error.code ?? "error"}`);
  report.lastSyncedAt = connection.data?.lastSyncedAt ?? null;
  if (connection.data?.status !== "connected") {
    report.result = "not_connected";
    return;
  }

  const attempt = await connectorStore.getFirefliesAttempt(tcw);
  if (!attempt.ok && attempt.error.code !== "KV_NOT_FOUND") {
    throw new RunnerError(storeFailure(attempt.error), `read attempt: ${attempt.error.code ?? "error"}`);
  }
  const lastAttempt = attempt.ok ? attempt.data : null;
  report.lastRunAt = lastAttempt?.lastAttemptAt ?? null;
  report.status = lastAttempt?.lastAttemptStatus ?? null;

  // The watermark stays the trigger: a connector that keeps finishing partial re-syncs each sweep.
  const lastSyncedMs = report.lastSyncedAt ? Date.parse(report.lastSyncedAt) : Number.NaN;
  if (deps.mode === "auto" && !state.auditCursor && Number.isFinite(lastSyncedMs) && nowMs - lastSyncedMs <= (deps.staleMs ?? DEFAULT_STALE_MS)) {
    report.result = "fresh";
    return;
  }
  const lastAttemptMs = lastAttempt ? Date.parse(lastAttempt.lastAttemptAt) : Number.NaN;
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < BUSY_WINDOW_MS) {
    report.result = "busy";
    return;
  }

  const budget = Math.min(MAX_REQUESTS_PER_RUN, MAX_REQUESTS_PER_DAY - state.requests);
  if (state.runs >= MAX_RUNS_PER_DAY || budget <= 0) {
    report.result = "capped";
    return;
  }

  const before = await deps.audit.tables();
  const apiKey = await deps.readApiKey();
  // State is written as it changes, so a killed run still counts its requests and its inserted rows.
  state.runs += 1;
  writeState(stateFile, state);
  const counter = countingFetch(deps.fetchImpl ?? globalThis.fetch.bind(globalThis), budget, () => {
    state.requests += 1;
    writeState(stateFile, state);
  });
  const defaults = defaultFirefliesClientOptions();
  const client = new FirefliesClient({
    apiKey,
    apiUrl: deps.apiUrl ?? defaults.apiUrl,
    delayMs: deps.delayMs ?? defaults.delayMs,
    fetchImpl: counter.fetch,
  });

  state.inserted = state.inserted.filter((entry) => nowMs - Date.parse(entry.at) < RECHECK_INSERTED_MS);
  let storageFull = false;
  const watch = <T>(res: StoreResult<T>): StoreResult<T> => {
    if (!res.ok && isStorageFullError(res.error)) storageFull = true;
    return res;
  };
  const store: SyncStore = {
    ...connectorStore,
    insertMeeting: async (target, meeting) => {
      const res = watch(await connectorStore.insertMeeting(target, meeting));
      if (res.ok && res.data) {
        state.inserted.push({ id: meeting.id, at: clock().toISOString() });
        writeState(stateFile, state);
      }
      return res;
    },
    putTranscriptBody: async (...args) => watch(await connectorStore.putTranscriptBody(...args)),
    updateSyncState: async (...args) => watch(await connectorStore.updateSyncState(...args)),
    recordFirefliesAttempt: async (...args) => watch(await connectorStore.recordFirefliesAttempt(...args)),
  };

  try {
    const sync = await syncFireflies({ client, store, tcw });
    if (sync.ok) {
      report.added = sync.data.added;
      report.skipped = sync.data.skipped;
      report.errors = sync.data.errors.length;
    } else {
      report.errors = 1;
      report.detail = sync.error.kind;
    }

    report.duplicateRowsRemoved = await removeOwnDuplicates(deps.audit, state.inserted.map((entry) => entry.id));

    if (sync.ok) {
      if (budget - counter.used() >= GAP_AUDIT_PAGES) {
        const gaps = await gapAudit(client, tcw, nowMs, state.auditCursor);
        report.gapIds = gaps.found;
        report.requeued = gaps.requeued;
        report.gapAuditComplete = gaps.complete;
        state.auditCursor = gaps.complete ? undefined : gaps.cursor ?? INITIAL_AUDIT_CURSOR;
      } else {
        report.gapAuditComplete = false;
        state.auditCursor ??= INITIAL_AUDIT_CURSOR;
      }
    }

    const after = await deps.audit.tables();
    report.schemaChanged = after.schemaHash !== before.schemaHash;
    for (const table of new Set([...Object.keys(before.counts), ...Object.keys(after.counts)])) {
      const delta = (after.counts[table] ?? 0) - (before.counts[table] ?? 0);
      if (delta !== 0) report.tableDeltas[table] = delta;
    }

    const finalAttempt = await connectorStore.getFirefliesAttempt(tcw);
    if (finalAttempt.ok && finalAttempt.data) {
      report.status = finalAttempt.data.lastAttemptStatus;
      report.lastRunAt = finalAttempt.data.lastAttemptAt;
    }
    const finalConnection = await connectorStore.getConnection(tcw, SOURCE);
    if (finalConnection.ok) report.lastSyncedAt = finalConnection.data?.lastSyncedAt ?? null;

    // The attempt record is itself a KV write: when it fails, `status` is the previous run's, so it
    // cannot vouch for this one. Any failed write or engine error makes the run an error.
    if (storageFull || !sync.ok || report.errors > 0) report.status = "error";
    const capped = counter.used() >= budget;
    if (storageFull) {
      report.result = "storage_full";
    } else if (!sync.ok) {
      report.result = sync.error.kind === "auth" ? "needs_reconnect"
        : sync.error.kind === "rate-limited" && capped ? "capped"
          : "error";
    } else if (report.status !== "ok" || report.gapAuditComplete === false) {
      // Incomplete audit may still hold missing meetings beyond this run's provider page cap.
      report.result = capped ? "capped" : "partial";
    } else {
      report.result = "synced";
    }
  } finally {
    report.httpRequests = counter.used();
    report.runsToday = state.runs;
    report.requestsToday = state.requests;
    writeState(stateFile, state);
  }
}

/** Delete only rows this runner inserted when another row holds the same Fireflies id. */
async function removeOwnDuplicates(audit: AuditPort, ownIds: string[]): Promise<number> {
  let removed = 0;
  for (const id of new Set(ownIds)) {
    const siblings = await audit.siblingsOf(id);
    if (siblings.includes(id) && siblings.length > 1) {
      await audit.deleteOwnRow(id);
      removed++;
    }
  }
  return removed;
}

/** Re-queue recent Fireflies ids that have no row, through the engine's own pendingIds. */
async function gapAudit(
  client: FirefliesClient,
  tcw: TinyCloudWeb,
  nowMs: number,
  cursor?: RunnerState["auditCursor"],
): Promise<{ found: number; requeued: number; complete: boolean; cursor?: RunnerState["auditCursor"] }> {
  const known = await connectorStore.listKnownSourceIds(tcw, SOURCE);
  if (!known.ok) return { found: 0, requeued: 0, complete: false, cursor };
  const listing = await client.listNewTranscriptIds({
    knownIds: known.data,
    pageBudget: cursor ? GAP_AUDIT_PAGES + 4 : GAP_AUDIT_PAGES,
    detailCap: MAX_PENDING_IDS,
    startSkip: cursor?.skip,
    startAnchor: cursor?.anchor,
    startAnchorDate: cursor?.anchorDate,
    startPreviousNeighbor: cursor?.previousNeighbor,
    stopBeforeDate: new Date(nowMs - GAP_WINDOW_MS).toISOString(),
  });
  if (!listing.ok) return { found: 0, requeued: 0, complete: false, cursor };
  const { ids, complete, nextSkip, nextAnchor, nextAnchorDate, nextPreviousNeighbor } = listing.data;
  const nextCursor = complete ? undefined : { skip: nextSkip, anchor: nextAnchor, anchorDate: nextAnchorDate, previousNeighbor: nextPreviousNeighbor };
  if (ids.length === 0) return { found: 0, requeued: 0, complete, cursor: nextCursor };
  const attempt = await connectorStore.getFirefliesAttempt(tcw);
  if (!attempt.ok || !attempt.data) return { found: ids.length, requeued: 0, complete: false, cursor };
  const pending = new Set(attempt.data.pendingIds ?? []);
  const before = pending.size;
  let overflow = false;
  for (const id of ids) {
    if (pending.has(id)) continue;
    if (pending.size < MAX_PENDING_IDS) pending.add(id);
    else overflow = true;
  }
  const retainedCursor = overflow ? cursor : nextCursor;
  if (pending.size === before) return { found: ids.length, requeued: 0, complete: !overflow && complete, cursor: retainedCursor };
  const written = await connectorStore.recordFirefliesAttempt(tcw, { ...attempt.data, pendingIds: [...pending] });
  return { found: ids.length, requeued: written.ok ? pending.size - before : 0, complete: written.ok && !overflow && complete, cursor: written.ok ? retainedCursor : cursor };
}

function storeFailure(error: { code?: string; message?: string }): RunResult {
  if (isStorageFullError(error)) return "storage_full";
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  return /AUTH|UNAUTHORI|PERMISSION|EXPIRED|401|403/i.test(text) ? "needs_renewal" : "error";
}

// ── Real ports ──────────────────────────────────────────────────────────

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function rowsOf(result: unknown): unknown[][] {
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true) {
    const error = result && typeof result === "object" && "error" in result && result.error && typeof result.error === "object"
      ? result.error
      : {};
    const code = "code" in error ? String(error.code) : "SQL_ERROR";
    const message = "message" in error ? String(error.message) : "";
    throw new RunnerError(storeFailure({ code, message }), `sql: ${code}`);
  }
  const data = "data" in result ? result.data : null;
  return data && typeof data === "object" && "rows" in data && Array.isArray(data.rows)
    ? data.rows.filter((row: unknown): row is unknown[] => Array.isArray(row))
    : [];
}

export function sqlAuditPort(tcw: TinyCloudWeb): AuditPort {
  const db = tcw.sql.db(CONNECTORS_SQL_DB_NAME);
  return {
    async tables() {
      const rows = rowsOf(await db.query("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name"));
      const counts: Record<string, number> = {};
      const hash = createHash("sha256");
      for (const [name, sql] of rows) {
        hash.update(`${String(name)}\n${String(sql)}\n`);
        if (typeof name !== "string" || !TABLE_NAME.test(name) || name.startsWith("sqlite_")) continue;
        const [count] = rowsOf(await db.query(`SELECT COUNT(*) FROM "${name}"`));
        counts[name] = Number(count?.[0] ?? 0);
      }
      return { counts, schemaHash: hash.digest("hex") };
    },
    async siblingsOf(id) {
      const rows = rowsOf(await db.query(
        "SELECT id FROM connector_meeting WHERE source = ? AND source_id = (SELECT source_id FROM connector_meeting WHERE id = ?)",
        [SOURCE, id],
      ));
      return rows.map((row) => String(row[0]));
    },
    async deleteOwnRow(id) {
      rowsOf(await db.execute("DELETE FROM connector_meeting WHERE id = ? AND source = ?", [id, SOURCE]));
    },
  };
}

interface ProfileFiles {
  host: string;
  ownerDid: string;
  spaceId: string;
  expiresAt: string | null;
  session: Parameters<TinyCloudNode["restoreSession"]>[0];
}

function readJson(file: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RunnerError("needs_renewal", `no session file ${file.split("/").slice(-2).join("/")}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RunnerError("needs_renewal", `unreadable ${file}`);
  return Object.fromEntries(Object.entries(parsed));
}

function str(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function loadProfile(home: string, name: string): ProfileFiles {
  const dir = join(home, "profiles", name);
  const profile = readJson(join(dir, "profile.json"));
  const session = readJson(join(dir, "session.json"));
  const key = readJson(join(dir, "key.json"));
  const header = session.delegationHeader;
  const authorization = header && typeof header === "object" && "Authorization" in header && typeof header.Authorization === "string"
    ? header.Authorization
    : undefined;
  const host = str(profile, "host");
  const ownerDid = str(profile, "ownerDid") ?? str(session, "ownerDid");
  const spaceId = str(session, "spaceId");
  const delegationCid = str(session, "delegationCid");
  const verificationMethod = str(session, "verificationMethod") ?? str(profile, "sessionDid");
  if (!authorization || !host || !ownerDid || !spaceId || !delegationCid || !verificationMethod) {
    throw new RunnerError("needs_renewal", `profile ${name} has no usable session`);
  }
  const chainId = session.chainId;
  return {
    host,
    ownerDid: ownerDid.split("#")[0],
    spaceId,
    expiresAt: str(session, "expiresAt") ?? null,
    session: {
      delegationHeader: { Authorization: authorization },
      delegationCid,
      spaceId,
      jwk: key,
      verificationMethod,
      address: str(session, "address"),
      chainId: typeof chainId === "number" ? chainId : undefined,
      siwe: str(session, "siwe"),
      signature: str(session, "signature"),
    },
  };
}

/** Reads the key through the CLI into memory; stdout is never echoed, stderr yields only a code. */
export async function readKeyWithCli(tc: string, profile: string): Promise<string> {
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn(tc, ["--profile", profile, "secrets", "get", "FIREFLIES_API_KEY", "--raw"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    child.stderr.on("data", (chunk) => { err += String(chunk); });
    child.on("error", () => resolve({ stdout: "", stderr: "", code: -1 }));
    child.on("close", (exit) => resolve({ stdout: out, stderr: err, code: exit }));
  });
  const value = stdout.trim();
  if (code === 0 && value.length > 0) return value;
  const errorCode = /"code"\s*:\s*"([A-Z_]+)"/.exec(stderr)?.[1] ?? `exit-${code}`;
  throw new RunnerError(/AUTH|PERMISSION|EXPIRED|PROFILE/.test(errorCode) ? "needs_renewal" : "error", `secrets get: ${errorCode}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────

interface CliArgs {
  mode: "auto" | "now";
  owner: string;
  tc: string;
  writeProfile: string;
  keyProfile: string;
  stateDir: string;
  log: string | null;
  staleHours: number;
}

function parseArgs(argv: string[]): CliArgs {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const owner = value("--owner");
  const tc = value("--tc");
  if (!owner || !/^did:pkh:eip155:\d+:0x[0-9a-fA-F]{40}$/.test(owner) || !tc) {
    throw new Error("usage: fireflies.ts [--now] --owner <did:pkh> --tc <path to tc> [--profile connector-sync] [--key-profile connector-sync-key] [--state-dir DIR] [--log FILE] [--stale-hours 6]");
  }
  const staleHours = Number(value("--stale-hours") ?? 6);
  return {
    mode: argv.includes("--now") ? "now" : "auto",
    owner,
    tc,
    writeProfile: value("--profile") ?? "connector-sync",
    keyProfile: value("--key-profile") ?? "connector-sync-key",
    stateDir: value("--state-dir") ?? join(homedir(), ".local", "state", "connector-sync"),
    log: value("--log") ?? null,
    staleHours: Number.isFinite(staleHours) && staleHours >= 0 ? staleHours : 6,
  };
}

export const EXIT_CODES: Record<RunResult, number> = {
  synced: 0, fresh: 0, not_connected: 0, busy: 75, capped: 75, partial: 75, locked: 75, storage_full: 75,
  needs_reconnect: 3, needs_renewal: 3, error: 1,
};

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const at = new Date();
  let report: RunReport;
  const artifactFile = join(args.stateDir, NAMED_GRANT_FILE);
  const keySource = hasNamedGrantFile(artifactFile) ? "named" : "legacy";
  try {
    const home = process.env.TC_HOME ?? join(homedir(), ".tinycloud");
    const profile = loadProfile(home, args.writeProfile);
    const [, , , chain, address] = args.owner.split(":");
    const expectedSpace = `tinycloud:pkh:eip155:${chain}:${address.toLowerCase()}:applications`;
    if (profile.ownerDid.toLowerCase() !== args.owner.toLowerCase() || profile.spaceId.toLowerCase() !== expectedSpace) {
      throw new RunnerError("error", "write profile is not signed in to the owner's applications space");
    }
    if (profile.expiresAt && Date.parse(profile.expiresAt) <= at.getTime()) {
      throw new RunnerError("needs_renewal", "write profile grant expired");
    }
    const node = new TinyCloudNode({ host: profile.host, includeAccountRegistryPermissions: false });
    await node.restoreSession(profile.session);
    // node-sdk's TinyCloudNode exposes the kv/sql/did/spaceId surface the connector store uses.
    const tcw: TinyCloudWeb = node as unknown as TinyCloudWeb;
    const key = await prepareFirefliesKeySource({
      file: artifactFile, node, ownerDid: profile.ownerDid,
      recipientDid: profile.session.verificationMethod!, host: profile.host,
      readLegacyKey: () => readKeyWithCli(args.tc, args.keyProfile), now: at.getTime(),
    });
    report = await runFirefliesAgentSync({
      tcw,
      readApiKey: key.readApiKey,
      keySource: key.keySource,
      namedGrant: key.namedGrant,
      audit: sqlAuditPort(tcw),
      stateDir: args.stateDir,
      mode: args.mode,
      staleMs: args.staleHours * 60 * 60 * 1000,
    });
  } catch (error) {
    report = {
      ...emptyReport(args.mode, at, keySource),
      result: error instanceof RunnerError || error instanceof NamedGrantError ? error.result : "error",
      detail: error instanceof RunnerError || error instanceof NamedGrantError ? error.result : "unexpected_error",
    };
  }
  const line = JSON.stringify(report);
  console.log(line);
  if (args.log) {
    mkdirSync(join(args.log, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(args.log, `${line}\n`, { flag: "a", mode: 0o600 });
  }
  return EXIT_CODES[report.result];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
