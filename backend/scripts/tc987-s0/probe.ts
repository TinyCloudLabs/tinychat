/**
 * TC-987 S0 feasibility probe (docs/plans/tc-987-workflow-run-queue.md §2.1, §4 S0).
 *
 * Runs against a throwaway LOCAL tinycloud-node only (loopback host enforced), with throwaway
 * keys generated per run. It never touches production or real user data.
 *
 *   backend/scripts/tc987-s0/run-node.sh            # throwaway node, own process group + watchdog
 *   TC987_HOST=http://127.0.0.1:18471 bun backend/scripts/tc987-s0/probe.ts
 *
 * output.txt beside this file is the run reported on TC-987.
 *
 * Actors:
 *   - owner: a fresh user key standing in for the browser. It signs in, creates the library and
 *     connector tables (G1 carries no schema ability), and mints two session-key grants to the
 *     backend's did:pkh: the TC-677-shaped G1 (sql read+write, exactly
 *     xyz.tinycloud.feed-workflows/library, no caveats) and TC-641's transcript-writer grant.
 *   - workerA / workerB: two independent backend TinyCloudNode instances with the same backend
 *     key (as two processes, or one process before and after a restart), each activating G1.
 *
 * Items (S0): 1 INSERT … ON CONFLICT; 2 conditional UPDATE affected-row count (fenced claim);
 * 3 named statements / constrained profile; 4 single-statement fenced-pointer commit hides a
 * stale attempt; 5 connector_meeting.started_at via the transcript-writer grant.
 *
 * Nothing here touches the in-app TinyChat/Eliza agent or its grant.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { TinyCloudNode, serializeDelegation } from "@tinycloud/node-sdk";
import {
  CONNECTORS_SQL_DB_NAME,
  TRANSCRIPT_WRITER_PERMISSIONS,
  connectorMeetingId,
  ensureConnectorSchema,
  writeTranscriberMeeting,
  type ConnectorStorePort,
  type PortResult,
} from "@tinyboilerplate/core";
import { verifyTranscriptWriterGrant } from "../../src/delegation-verify.js";
import { activateVerifiedDelegation } from "../../src/portable-delegation.js";
import { delegatedConnectorPort } from "../../src/services/user-space-port.js";

const HOST = process.env.TC987_HOST ?? "http://127.0.0.1:18471";
const STALL_MS = Number(process.env.TC987_STALL_MS ?? 5_000);
const CALL_DEADLINE_MS = Number(process.env.TC987_CALL_DEADLINE_MS ?? 60_000);
const CONTENDER_TRIALS = Number(process.env.TC987_CONTENDER_TRIALS ?? 20);
const LIB = "xyz.tinycloud.feed-workflows/library";

const hostname = new URL(HOST).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
  throw new Error(`refusing non-loopback host ${HOST}: S0 runs against a local node only`);
}

// ---------------------------------------------------------------- recording

type Verdict = "PASS" | "FAIL" | "INFO";
const results: Array<{ item: string; check: string; verdict: Verdict; detail: string }> = [];
const calls: Array<{ label: string; ms: number }> = [];
const stalls: Array<{ label: string; ms: number; outcome: string }> = [];

function record(item: string, check: string, verdict: Verdict, detail: unknown) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ item, check, verdict, detail: text });
  console.log(`[S0] item=${item} verdict=${verdict} check="${check}" detail=${text}`);
}
const expectEq = (item: string, check: string, actual: unknown, expected: unknown, extra?: unknown) =>
  record(item, check, JSON.stringify(actual) === JSON.stringify(expected) ? "PASS" : "FAIL",
    { actual, expected, ...(extra === undefined ? {} : { extra }) });

/** Time every node call; a call over STALL_MS or past the deadline is TC-1274 evidence. */
async function timed<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const started = performance.now();
  let outcome = "ok";
  try {
    return await fn(AbortSignal.timeout(CALL_DEADLINE_MS));
  } catch (error) {
    outcome = error instanceof Error ? `throw:${error.name}:${error.message.slice(0, 160)}` : `throw:${String(error)}`;
    throw error;
  } finally {
    const ms = Math.round(performance.now() - started);
    calls.push({ label, ms });
    if (ms >= STALL_MS) {
      stalls.push({ label, ms, outcome });
      console.log(`[S0] STALL label=${label} ms=${ms} outcome=${outcome}`);
    }
  }
}

type SqlResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string; meta?: { status?: unknown } } };
type Exec = { changes: number; lastInsertRowId: number | null };
type Rows = { columns: string[]; rows: unknown[][]; rowCount: number };
interface Db {
  execute(sql: string, params?: unknown[], options?: { signal?: AbortSignal }): Promise<SqlResult<Exec>>;
  query(sql: string, params?: unknown[], options?: { signal?: AbortSignal }): Promise<SqlResult<Rows>>;
  batch(statements: Array<{ sql: string; params?: unknown[] }>, options?: { signal?: AbortSignal }): Promise<SqlResult<{ results: Exec[] }>>;
  executeStatement(name: string, params?: unknown[], options?: { signal?: AbortSignal }): Promise<SqlResult<Exec>>;
}
const describeError = (r: SqlResult<unknown>) =>
  r.ok ? "ok" : `${r.error.code} status=${String(r.error.meta?.status)} ${r.error.message.slice(0, 200)}`;

async function exec(db: Db, label: string, sql: string, params: unknown[] = []): Promise<SqlResult<Exec>> {
  return timed(label, (signal) => db.execute(sql, params as never[], { signal }));
}
async function mustExec(db: Db, label: string, sql: string, params: unknown[] = []): Promise<Exec> {
  const r = await exec(db, label, sql, params);
  if (!r.ok) throw new Error(`${label}: ${describeError(r)}`);
  return r.data;
}
async function rows(db: Db, label: string, sql: string, params: unknown[] = []): Promise<unknown[][]> {
  const r = await timed(label, (signal) => db.query(sql, params as never[], { signal }));
  if (!r.ok) throw new Error(`${label}: ${describeError(r)}`);
  return r.data.rows;
}

// ---------------------------------------------------------------- schema and statements (plan §2.1)

const LIBRARY_DDL = [
  `CREATE TABLE IF NOT EXISTS workflow_runs (
    run_key TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, workflow_id TEXT NOT NULL, version TEXT NOT NULL,
    state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
    claim_token TEXT, claim_gen INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
    published_attempt INTEGER, outcome TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  // Immutable, attempt-scoped outputs: one row per acquisition (attempt = claim_gen). Home never
  // reads this table directly, only through workflow_runs.published_attempt.
  `CREATE TABLE IF NOT EXISTS workflow_run_outputs (
    run_key TEXT NOT NULL, attempt INTEGER NOT NULL, artifact_id TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (run_key, attempt))`,
  // Negative control: today's overwritable publication keyed by the deterministic artifactId.
  `CREATE TABLE IF NOT EXISTS artifacts (artifact_id TEXT PRIMARY KEY, content TEXT NOT NULL, updated_at TEXT NOT NULL)`,
];

const SQL = {
  create: `INSERT INTO workflow_runs (run_key, meeting_id, workflow_id, version, state, attempt, next_at, claim_gen, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?) ON CONFLICT(run_key) DO NOTHING`,
  upsertVersion: `INSERT INTO workflow_runs (run_key, meeting_id, workflow_id, version, state, attempt, next_at, claim_gen, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', 0, ?, 0, ?, ?) ON CONFLICT(run_key) DO UPDATE SET updated_at = excluded.updated_at WHERE workflow_runs.state = 'queued'`,
  acquire: `UPDATE workflow_runs SET claim_token = ?, claim_gen = claim_gen + 1, state = 'claimed', lease_until = ?, updated_at = ?
    WHERE run_key = ? AND claim_gen = ? AND state = 'queued' AND next_at <= ?`,
  reclaim: `UPDATE workflow_runs SET claim_token = ?, claim_gen = claim_gen + 1, state = 'claimed', lease_until = ?, updated_at = ?
    WHERE run_key = ? AND claim_gen = ? AND state = 'claimed' AND lease_until < ?`,
  renew: `UPDATE workflow_runs SET lease_until = ?, updated_at = ? WHERE run_key = ? AND state = 'claimed' AND claim_token = ?`,
  retry: `UPDATE workflow_runs SET state = 'queued', next_at = ?, attempt = attempt + 1, claim_token = NULL, lease_until = NULL, updated_at = ?
    WHERE run_key = ? AND state = 'claimed' AND claim_token = ?`,
  publish: `UPDATE workflow_runs SET state = 'done', published_attempt = ?, claim_token = NULL, lease_until = NULL, updated_at = ?
    WHERE run_key = ? AND state = 'claimed' AND claim_token = ?`,
  writeOutput: `INSERT INTO workflow_run_outputs (run_key, attempt, artifact_id, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  resolve: `SELECT o.content, r.published_attempt, r.state FROM workflow_runs r
    JOIN workflow_run_outputs o ON o.run_key = r.run_key AND o.attempt = r.published_attempt WHERE r.run_key = ?`,
  row: `SELECT state, claim_gen, claim_token, lease_until, published_attempt, attempt FROM workflow_runs WHERE run_key = ?`,
  legacyPublish: `INSERT INTO artifacts (artifact_id, content, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  legacyRead: `SELECT content FROM artifacts WHERE artifact_id = ?`,
  deadlineCas: `UPDATE workflow_runs SET updated_at = ? WHERE run_key = ? AND CAST(strftime('%s','now') AS INTEGER) < ? - 5`,
};

const iso = () => new Date().toISOString();
const token = () => randomUUID();

async function newRun(db: Db, label: string) {
  const runKey = `rk-${label}-${randomBytes(6).toString("hex")}`;
  const now = Date.now();
  const r = await mustExec(db, `create:${label}`, SQL.create, [runKey, `m-${label}`, "meeting-digest", "v1", now - 1, iso(), iso()]);
  if (r.changes !== 1) throw new Error(`create ${label}: changes=${r.changes}`);
  return runKey;
}
async function readRow(db: Db, runKey: string) {
  const [row] = await rows(db, "row", SQL.row, [runKey]);
  const [state, claimGen, claimToken, leaseUntil, publishedAttempt, attempt] = row ?? [];
  return { state, claimGen: Number(claimGen), claimToken, leaseUntil, publishedAttempt, attempt };
}

// ---------------------------------------------------------------- identities

const tinychatManifest = JSON.parse(readFileSync(new URL("../../../manifest.json", import.meta.url), "utf8"));
// TC-677 adds the library to the browser session so delegateTo(G1) stays a silent session-key UCAN.
const feedLibraryManifest = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.feed-workflows",
  name: "Feed workflows library (TC-987 S0 probe)",
  defaults: false,
  permissions: [{ service: "tinycloud.sql", path: "library", actions: ["read", "write", "schema"] }],
};
const G1_PERMISSIONS = [
  { service: "tinycloud.sql", space: "applications", path: LIB, actions: ["read", "write"], skipPrefix: true },
];

const ownerKey = `0x${randomBytes(32).toString("hex")}`;
const backendKey = `0x${randomBytes(32).toString("hex")}`;

async function backendNode(): Promise<TinyCloudNode> {
  const node = new TinyCloudNode({
    privateKey: backendKey, host: HOST, prefix: "ops.tinychat.backend",
    autoCreateSpace: true, autoDiscoverLocalNode: false, autoBootstrapAccount: false,
  } as never);
  await timed("backend.signIn", () => node.signIn());
  return node;
}

/** The browser's toPortableDelegation(): the SDK's delegation plus owner/chain/host. */
function portable(delegation: Record<string, unknown>, owner: TinyCloudNode) {
  return { ...delegation, ownerAddress: owner.address!.toLowerCase(), chainId: 1, host: HOST };
}

// ---------------------------------------------------------------- main

async function main() {
  const version = await (await fetch(`${HOST}/version`)).json();
  console.log(`[S0] node host=${HOST} version=${JSON.stringify(version)}`);

  const owner = new TinyCloudNode({
    privateKey: ownerKey, host: HOST, manifest: [tinychatManifest, feedLibraryManifest],
    autoCreateSpace: true, autoDiscoverLocalNode: false, autoBootstrapAccount: false,
  } as never);
  await timed("owner.signIn", () => owner.signIn());
  const ownerLib = owner.sql.db(LIB) as unknown as Db;
  for (const ddl of LIBRARY_DDL) await mustExec(ownerLib, "owner.ddl", ddl);
  console.log(`[S0] owner=${owner.did} space=${owner.spaceId} library tables created by owner`);

  const workerANode = await backendNode();
  const workerBNode = await backendNode();
  const backendDid = workerANode.did;
  console.log(`[S0] backend did=${backendDid}`);

  // G1: TC-677-shaped grant. Silent session-key UCAN, no caveats.
  const g1 = await timed("owner.delegateTo(G1)", () => owner.delegateTo(backendDid, G1_PERMISSIONS as never, { expiry: "1h" } as never));
  const g1Header = "delegationHeader" in g1.delegation ? g1.delegation.delegationHeader : undefined;
  const g1Jwt = g1Header && typeof g1Header === "object" && "Authorization" in g1Header ? String(g1Header.Authorization) : "";
  const g1Payload = JSON.parse(Buffer.from(g1Jwt.replace(/^Bearer /, "").split(".")[1] ?? "", "base64url").toString("utf8"));
  record("grant", "G1 is a silent session-key UCAN (prompted=false)", g1.prompted ? "FAIL" : "PASS", { prompted: g1.prompted });
  record("grant", "G1 att is exactly sql read+write on the library with empty nota-bene", "INFO", { aud: g1Payload.aud, att: g1Payload.att });
  const g1Portable = portable(g1.delegation as never, owner);
  const accessA = await timed("workerA.useDelegation(G1)", () => workerANode.useDelegation(g1Portable as never));
  const accessB = await timed("workerB.useDelegation(G1)", () => workerBNode.useDelegation(g1Portable as never));
  const A = accessA.sql.db(LIB) as unknown as Db;
  const B = accessB.sql.db(LIB) as unknown as Db;

  // Under G1 the SDK signs DDL with tinycloud.sql/schema, which G1 lacks (TC-677 relevance).
  const ddlUnderG1 = await exec(A, "g1.ddl", "CREATE TABLE IF NOT EXISTS g1_ddl_probe (x TEXT)");
  record("note", "DDL via SDK under G1 (read+write only)", "INFO", ddlUnderG1.ok ? "accepted" : describeError(ddlUnderG1));

  // ------------------------------------------------ Item 1: INSERT … ON CONFLICT under G1
  {
    const runKey = `rk-item1-${randomBytes(6).toString("hex")}`;
    const now = Date.now();
    const p = [runKey, "m-item1", "meeting-digest", "v1", now, iso(), iso()];
    const first = await exec(A, "item1.create#1", SQL.create, p);
    const second = await exec(B, "item1.create#2", SQL.create, p);
    expectEq("1", "first INSERT … ON CONFLICT(run_key) DO NOTHING inserts (changes=1)", first.ok ? first.data.changes : describeError(first), 1);
    expectEq("1", "duplicate enqueue is a no-op (changes=0, no error)", second.ok ? second.data.changes : describeError(second), 0);
    const upsert = await exec(A, "item1.upsert", SQL.upsertVersion, p);
    expectEq("1", "INSERT … ON CONFLICT DO UPDATE … WHERE (upsert form) accepted (changes=1)", upsert.ok ? upsert.data.changes : describeError(upsert), 1);
    expectEq("1", "exactly one row for the run_key", (await rows(A, "item1.count", "SELECT COUNT(*) FROM workflow_runs WHERE run_key = ?", [runKey]))[0]?.[0], 1);
  }

  // ------------------------------------------------ Item 2: conditional UPDATE affected-row count
  {
    const runKey = await newRun(A, "item2");
    const now = Date.now();
    const tA = token();
    const acq = await mustExec(A, "item2.acquire", SQL.acquire, [tA, now + 60_000, iso(), runKey, 0, now]);
    expectEq("2", "acquire with fresh claim_gen=0 → changes=1", acq.changes, 1);
    const stale = await mustExec(B, "item2.acquire.stale", SQL.acquire, [token(), now + 60_000, iso(), runKey, 0, now]);
    expectEq("2", "second acquire with the same seen claim_gen → changes=0", stale.changes, 0);
    const notDue = await newRun(A, "item2-notdue");
    await mustExec(A, "item2.defer", "UPDATE workflow_runs SET next_at = ? WHERE run_key = ?", [now + 3_600_000, notDue]);
    expectEq("2", "acquire of a run whose next_at is in the future → changes=0",
      (await mustExec(A, "item2.acquire.notdue", SQL.acquire, [token(), now + 60_000, iso(), notDue, 0, now])).changes, 0);
    expectEq("2", "renew with own token → changes=1", (await mustExec(A, "item2.renew", SQL.renew, [now + 120_000, iso(), runKey, tA])).changes, 1);
    expectEq("2", "renew with a foreign token → changes=0 (lease lost)", (await mustExec(B, "item2.renew.foreign", SQL.renew, [now + 120_000, iso(), runKey, token()])).changes, 0);
    expectEq("2", "reclaim of an unexpired lease → changes=0", (await mustExec(B, "item2.reclaim.live", SQL.reclaim, [token(), now + 60_000, iso(), runKey, 1, Date.now()])).changes, 0);
    await mustExec(A, "item2.expire", SQL.renew, [Date.now() - 1, iso(), runKey, tA]);
    const tB = token();
    expectEq("2", "reclaim of an expired lease with seen claim_gen=1 → changes=1", (await mustExec(B, "item2.reclaim", SQL.reclaim, [tB, Date.now() + 60_000, iso(), runKey, 1, Date.now()])).changes, 1);
    expectEq("2", "old holder's renew after reclaim → changes=0", (await mustExec(A, "item2.renew.old", SQL.renew, [Date.now() + 60_000, iso(), runKey, tA])).changes, 0);
    expectEq("2", "retry by current holder → changes=1 and clears token/lease",
      (await mustExec(B, "item2.retry", SQL.retry, [Date.now() - 1, iso(), runKey, tB])).changes, 1);
    const afterRetry = await readRow(A, runKey);
    expectEq("2", "after retry: state=queued, claim_token/lease cleared, claim_gen=2",
      [afterRetry.state, afterRetry.claimToken, afterRetry.leaseUntil, afterRetry.claimGen], ["queued", null, null, 2]);

    // Two contenders read the same claim_gen and fire concurrently from two backend instances.
    let exactlyOne = 0;
    const outcomes: string[] = [];
    for (let i = 0; i < CONTENDER_TRIALS; i++) {
      const key = await newRun(A, `contend${i}`);
      const t = Date.now();
      const [ra, rb] = await Promise.all([
        exec(A, "item2.contend.A", SQL.acquire, [token(), t + 60_000, iso(), key, 0, t]),
        exec(B, "item2.contend.B", SQL.acquire, [token(), t + 60_000, iso(), key, 0, t]),
      ]);
      const ca = ra.ok ? ra.data.changes : -1;
      const cb = rb.ok ? rb.data.changes : -1;
      outcomes.push(`${ca}${cb}`);
      if (ca + cb === 1 && ca >= 0 && cb >= 0) exactlyOne++;
    }
    expectEq("2", `concurrent acquire from two instances, ${CONTENDER_TRIALS} trials: exactly one winner each`, exactlyOne, CONTENDER_TRIALS, { outcomes });

    // Terminal immutability: once done, no statement matches.
    const doneKey = await newRun(A, "item2-terminal");
    const tD = token();
    await mustExec(A, "item2.t.acquire", SQL.acquire, [tD, Date.now() + 60_000, iso(), doneKey, 0, Date.now()]);
    await mustExec(A, "item2.t.output", SQL.writeOutput, [doneKey, 1, "art-terminal", "terminal-content", iso()]);
    expectEq("2", "fenced publish by holder → changes=1", (await mustExec(A, "item2.t.publish", SQL.publish, [1, iso(), doneKey, tD])).changes, 1);
    const far = Date.now() + 10 * 3_600_000;
    const terminal = [
      (await mustExec(B, "item2.t.acquire2", SQL.acquire, [token(), far, iso(), doneKey, 1, far])).changes,
      (await mustExec(B, "item2.t.reclaim", SQL.reclaim, [token(), far, iso(), doneKey, 1, far])).changes,
      (await mustExec(A, "item2.t.renew", SQL.renew, [far, iso(), doneKey, tD])).changes,
      (await mustExec(A, "item2.t.retry", SQL.retry, [far, iso(), doneKey, tD])).changes,
      (await mustExec(A, "item2.t.publish2", SQL.publish, [2, iso(), doneKey, tD])).changes,
    ];
    expectEq("2", "done row: acquire/reclaim/renew/retry/publish all → changes=0", terminal, [0, 0, 0, 0, 0]);
    const terminalRow = await readRow(A, doneKey);
    expectEq("2", "done row unchanged (state=done, published_attempt=1, gen=1)", [terminalRow.state, terminalRow.publishedAttempt, terminalRow.claimGen], ["done", 1, 1]);

    // TC-677 SPIKE-D shape (strftime deadline predicate), on node main rather than the deployed line.
    const nowS = Math.floor(Date.now() / 1000);
    expectEq("note", "strftime deadline CAS, future deadline → changes=1", (await mustExec(A, "spiked.future", SQL.deadlineCas, [iso(), doneKey, nowS + 60])).changes, 1);
    expectEq("note", "strftime deadline CAS, expired deadline → changes=0", (await mustExec(A, "spiked.past", SQL.deadlineCas, [iso(), doneKey, nowS - 60])).changes, 0);
  }

  // ------------------------------------------------ Item 3: named statements / constrained profile
  // Node-side semantics of the constrained-statements caveat (read-only only; raw execute/batch
  // refused; write keywords in bound SQL refused) are covered by the node's own unit tests, run
  // separately (see the S0 report). This block checks whether node-sdk 3.2.1 can mint such a grant.
  {
    expectEq("3", "G1 is unconstrained: raw execute already accepted above, so named statements are not required",
      results.filter((r) => r.item === "2" && r.verdict === "FAIL").length, 0);
    const acquireNamed = { name: "acquire", sql: SQL.acquire.replace(/\s+/g, " ") };
    const variants: Array<{ label: string; caveat: Record<string, unknown>; stmt: string; params: unknown[] }> = [
      { label: "readOnly:false with a write statement", caveat: { mode: "constrained-statements", readOnly: false, statements: [acquireNamed] }, stmt: "acquire",
        params: [token(), Date.now() + 60_000, iso(), "rk-none", 0, Date.now()] },
      { label: "readOnly:true with a write statement", caveat: { mode: "constrained-statements", readOnly: true, statements: [acquireNamed] }, stmt: "acquire",
        params: [token(), Date.now() + 60_000, iso(), "rk-none", 0, Date.now()] },
      { label: "readOnly:true with a SELECT statement (control)", caveat: { mode: "constrained-statements", readOnly: true,
        statements: [{ name: "get", sql: "SELECT state FROM workflow_runs WHERE run_key = ?" }] }, stmt: "get", params: ["rk-none"] },
    ];
    for (const v of variants) {
      let stage = "delegateTo";
      try {
        const d = await timed(`item3.delegate:${v.label}`, () => owner.delegateTo(backendDid,
          [{ ...G1_PERMISSIONS[0], caveats: [v.caveat] }] as never, { expiry: "1h" } as never));
        stage = "useDelegation";
        const node = await backendNode();
        const access = await timed(`item3.use:${v.label}`, () => node.useDelegation(portable(d.delegation as never, owner) as never));
        stage = "executeStatement";
        const db = access.sql.db(LIB) as unknown as Db;
        const named = await timed(`item3.exec:${v.label}`, (signal) => db.executeStatement(v.stmt, v.params as never[], { signal }));
        const raw = await exec(db, `item3.raw:${v.label}`, "UPDATE workflow_runs SET updated_at = ? WHERE run_key = ?", [iso(), "rk-none"]);
        record("3", `node-sdk 3.2.1 delegateTo with constrained-statements ${v.label}`, "INFO", {
          prompted: d.prompted, executeStatement: named.ok ? named.data : describeError(named), rawExecute: raw.ok ? raw.data : describeError(raw),
        });
      } catch (error) {
        record("3", `node-sdk 3.2.1 delegateTo with constrained-statements ${v.label}`, "INFO", { failedAt: stage, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
      }
    }
  }

  // ------------------------------------------------ Item 4: fenced pointer hides a stale attempt
  type RaceMode = "pointer" | "legacy-upsert" | "batch";
  async function race(mode: RaceMode) {
    const runKey = await newRun(A, `race-${mode}`);
    const artifactId = `art-${runKey}`;
    const tA = token();
    const aChecked = Promise.withResolvers<void>();
    const resumeA = Promise.withResolvers<void>();
    const trace: string[] = [];
    let aPublish: unknown;

    const workerA = (async () => {
      const t = Date.now();
      const acq = await mustExec(A, "race.A.acquire", SQL.acquire, [tA, t + 60_000, iso(), runKey, 0, t]);
      trace.push(`A acquire changes=${acq.changes} gen=1`);
      // The token check: a fenced renew that succeeds, leaving a lease that will lapse while A is paused.
      const check = await mustExec(A, "race.A.tokencheck", SQL.renew, [Date.now() + 1_000, iso(), runKey, tA]);
      trace.push(`A token check changes=${check.changes}; pausing`);
      aChecked.resolve();
      await resumeA.promise;
      trace.push("A resumed");
      if (mode === "pointer") {
        const out = await exec(A, "race.A.output", SQL.writeOutput, [runKey, 1, artifactId, "content-from-STALE-attempt-A", iso()]);
        trace.push(`A attempt-scoped output ${out.ok ? `changes=${out.data.changes}` : describeError(out)}`);
        const pub = await mustExec(A, "race.A.publish", SQL.publish, [1, iso(), runKey, tA]);
        aPublish = pub.changes;
        trace.push(`A fenced publish changes=${pub.changes}`);
      } else if (mode === "legacy-upsert") {
        const pub = await mustExec(A, "race.A.legacy", SQL.legacyPublish, [artifactId, "content-from-STALE-attempt-A", iso()]);
        aPublish = pub.changes;
        trace.push(`A overwritable upsert changes=${pub.changes}`);
      } else {
        const r = await timed("race.A.batch", (signal) => A.batch([
          { sql: SQL.publish, params: [1, iso(), runKey, tA] },
          { sql: SQL.legacyPublish, params: [artifactId, "content-from-STALE-attempt-A", iso()] },
        ] as never, { signal }));
        aPublish = r.ok ? r.data.results.map((x) => x.changes) : describeError(r);
        trace.push(`A batch [fenced publish, upsert] → ${JSON.stringify(aPublish)}`);
      }
    })();

    await aChecked.promise;
    while (Date.now() <= (Number((await readRow(B, runKey)).leaseUntil) || 0)) await sleep(100);
    const seen = await readRow(B, runKey);
    const tB = token();
    const rec = await mustExec(B, "race.B.reclaim", SQL.reclaim, [tB, Date.now() + 60_000, iso(), runKey, seen.claimGen, Date.now()]);
    trace.push(`B reclaim (seen gen=${seen.claimGen}) changes=${rec.changes} gen=${seen.claimGen + 1}`);
    if (mode === "pointer") {
      await mustExec(B, "race.B.output", SQL.writeOutput, [runKey, seen.claimGen + 1, artifactId, "content-from-REPLACEMENT-attempt-B", iso()]);
      const pub = await mustExec(B, "race.B.publish", SQL.publish, [seen.claimGen + 1, iso(), runKey, tB]);
      trace.push(`B fenced publish changes=${pub.changes}`);
    } else {
      await mustExec(B, "race.B.legacy", SQL.legacyPublish, [artifactId, "content-from-REPLACEMENT-attempt-B", iso()]);
      const pub = await mustExec(B, "race.B.publish", SQL.publish, [seen.claimGen + 1, iso(), runKey, tB]);
      trace.push(`B upsert + fenced finish changes=${pub.changes}`);
    }
    resumeA.resolve();
    await workerA;

    if (mode === "pointer") {
      const [resolved] = await rows(A, "race.resolve", SQL.resolve, [runKey]);
      const outputs = await rows(A, "race.outputs", "SELECT attempt, content FROM workflow_run_outputs WHERE run_key = ? ORDER BY attempt", [runKey]);
      expectEq("4", "stale worker A's fenced publish matches zero rows", aPublish, 0, { trace });
      expectEq("4", "Home-resolved content (via published_attempt) is the replacement's",
        resolved, ["content-from-REPLACEMENT-attempt-B", 2, "done"], { outputs });
    } else {
      const [content] = await rows(A, "race.legacyRead", SQL.legacyRead, [artifactId]);
      record("4", `control (${mode}): stale worker overwrites the replacement's published content without the pointer`,
        content?.[0] === "content-from-STALE-attempt-A" ? "PASS" : "FAIL", { visible: content?.[0], aPublish, trace });
    }
  }
  await race("pointer");
  await race("legacy-upsert");
  await race("batch");

  // ------------------------------------------------ Item 5: connector_meeting start time via TC-641 grant
  {
    // Browser side: ensureConnectorSchema with the user's own session, then the silent transcript-writer grant.
    const ownerConnectors = owner.sql.db(CONNECTORS_SQL_DB_NAME) as unknown as Db;
    const ownerPort: ConnectorStorePort = {
      query: async (sql, params) => {
        const r = await timed("owner.connectors.query", (signal) => ownerConnectors.query(sql, params, { signal }));
        return r.ok ? { ok: true, data: { rows: r.data.rows } } : { ok: false, code: r.error.code, message: r.error.message };
      },
      execute: async (sql, params) => {
        const r = await exec(ownerConnectors, "owner.connectors.execute", sql, params ?? []);
        return (r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message }) as PortResult<unknown>;
      },
      kvGet: async () => { throw new Error("unused"); },
      kvPutIfAbsent: async () => { throw new Error("unused"); },
    };
    const schema = await ensureConnectorSchema(ownerPort);
    if (!schema.ok) throw new Error(`ensureConnectorSchema: ${schema.message}`);
    const grant = await timed("owner.delegateTo(transcript-writer)", () => owner.delegateTo(backendDid, TRANSCRIPT_WRITER_PERMISSIONS as never, { expiry: "1h" } as never));
    const serialized = serializeDelegation(portable(grant.delegation as never, owner) as never);
    // node-sdk types the session loosely; TinyCloudSession carries the signed SIWE and its signature.
    const session = owner.session as unknown as { siwe: string; signature: string };

    // Backend side: the production verifier, activation and confined port (TC-641 path).
    const backend = await backendNode();
    const verified = await verifyTranscriptWriterGrant({
      serialized, siwe: session.siwe, signature: session.signature, address: owner.address!, backendDid, configuredHost: HOST,
    }, { computeDelegationCid: (a) => backend.computeDelegationCid(a) });
    record("5", "transcript-writer grant passes backend verifyTranscriptWriterGrant", verified.ok ? "PASS" : "FAIL", verified.ok ? { resources: verified.verified.resources.map((r) => `${r.service}:${r.path}`) } : verified);
    if (!verified.ok) return;
    const access = await timed("backend.activateVerifiedDelegation", () => activateVerifiedDelegation(backend, verified.verified, { host: HOST }));
    const port = delegatedConnectorPort(access as never, (op) => op());

    const startedAt = "2026-10-16T15:04:05.000Z";
    const sourceId = `s0-${randomBytes(4).toString("hex")}`;
    const written = await writeTranscriberMeeting(port, {
      meeting: {
        id: await connectorMeetingId("tinycloud-transcriber", sourceId), source: "tinycloud-transcriber", sourceId, title: "S0 synthetic meeting",
        startedAt, durationSecs: 60, organizerEmail: null, participants: [], summaryOverview: null, summaryActionItems: null,
        keywords: null, meetingType: null, metadata: {},
      },
      body: "synthetic transcript body (S0 probe)",
    }, { ensureSchema: false });
    record("5", "backend writes a transcriber meeting through the grant (delivery path)", written.ok ? "PASS" : "FAIL", written.ok ? written.data : written);
    const read = await port.query("SELECT started_at FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1", ["tinycloud-transcriber", sourceId]);
    expectEq("5", "backend reads connector_meeting.started_at via the transcript-writer grant", read.ok ? read.data.rows[0]?.[0] : read, startedAt);
    const unknownId = `s0-unknown-${randomBytes(4).toString("hex")}`;
    // Seeded by the owner, as a connector without a start time would leave it.
    await mustExec(ownerConnectors, "owner.connectors.seed-unknown", `INSERT INTO connector_meeting (id, source, source_id, title, started_at, created_at, updated_at)
      VALUES (?, 'tinycloud-transcriber', ?, 'no start', NULL, ?, ?)`, [await connectorMeetingId("tinycloud-transcriber", unknownId), unknownId, iso(), iso()]);
    const unknown = await port.query("SELECT started_at FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1", ["tinycloud-transcriber", unknownId]);
    expectEq("5", "a meeting with no start time reads back as NULL (unknown_start path)", unknown.ok ? unknown.data.rows : unknown, [[null]]);
    const missing = await port.query("SELECT started_at FROM connector_meeting WHERE source = ? AND source_id = ? LIMIT 1", ["tinycloud-transcriber", "never-delivered"]);
    expectEq("5", "a meeting not yet in the space reads back as no row", missing.ok ? missing.data.rows : missing, []);
    // G1 is exact-path: the library grant alone cannot read the connectors DB, so the queue needs both grants.
    const g1Connectors = accessA.sql.db(CONNECTORS_SQL_DB_NAME) as unknown as Db;
    const g1Cross = await timed("item5.g1-cross", (signal) => g1Connectors.query("SELECT started_at FROM connector_meeting LIMIT 1", [], { signal }));
    record("5", "G1 (library grant) is refused on the connectors DB: start time needs the transcript-writer grant",
      g1Cross.ok ? "FAIL" : "PASS", g1Cross.ok ? "unexpectedly readable" : describeError(g1Cross));
  }
}

const startedAt = Date.now();
let fatal: unknown;
try {
  await main();
} catch (error) {
  fatal = error;
  record("fatal", "probe aborted", "FAIL", error instanceof Error ? error.stack ?? error.message : String(error));
}
const sorted = calls.map((c) => c.ms).sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
console.log("\n[S0] ===== summary =====");
for (const r of results) console.log(`[S0] ${r.verdict.padEnd(4)} item=${r.item.padEnd(5)} ${r.check}`);
const slowest = calls.reduce((a, b) => (b.ms > a.ms ? b : a), { label: "none", ms: 0 });
console.log(`[S0] node calls=${calls.length} p50=${pct(50)}ms p95=${pct(95)}ms max=${slowest.ms}ms (${slowest.label}) stalls(>=${STALL_MS}ms)=${stalls.length} wall=${Date.now() - startedAt}ms`);
for (const s of stalls) console.log(`[S0] stall ${JSON.stringify(s)}`);
const failed = results.filter((r) => r.verdict === "FAIL");
console.log(`[S0] RESULT ${failed.length === 0 && !fatal ? "ALL PASS" : `${failed.length} FAIL`}`);
process.exit(failed.length === 0 && !fatal ? 0 : 1);
