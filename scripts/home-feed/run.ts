import { spawn } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Result, SqlValue } from "@tinycloud/sdk-services";
import { initializeFeedHandoff, projectFeedResponseNotification } from "@tinycloud/sdk-services/feed";
import type { FeedDatabase, FeedResponse } from "@tinycloud/sdk-services/feed";
import { closeHomeMirror, homeMirrorDiagnostic, homeMirrorRefusal, publishHomeMirror, watchHomeMirrors } from "./bridge";
import { inventoryPlan, parseInventoryKinds, postMany, readBoardIndex } from "./inventory";
import { fullSpace, normalizeHomeMirrorHost, openOwnerSession, withStopSignal } from "./owner-session";

export { normalizeHomeMirrorHost };

const identity = z.object({ sourceId: z.string().min(1), cardId: z.string().uuid(), revision: z.number().int().positive().safe(), issuanceId: z.string().min(1) }).strict();
const watchInput = z.object({ sourceId: z.string().min(1), recipient: z.string().min(1).refine((value) => value !== "*"), runner: z.array(z.string().min(1)).nonempty(), renewalSeconds: z.number().int().min(60).max(300).optional() }).strict();
const usage = [
  "bun scripts/home-feed/run.ts post|close|watch --tc-home DIR --profile NAME --owner-space FULL_URI --legacy-space FULL_URI --file JSON [--host URL] [--handoff SQLITE_FILE for watch]",
  "bun scripts/home-feed/run.ts post-many --from-index BOARD_INDEX_SQLITE --source SOURCE_ID --owner-space FULL_URI --legacy-space FULL_URI [--kinds ask,task,incident,progress,work] [--dry-run | --tc-home DIR --profile NAME] [--host URL]",
  "Watch JSON: {sourceId,recipient,runner:[executable,...argv],renewalSeconds?}. Runner exit zero must mean durable acceptance of the full response ID; execution must recheck dispatchBefore.",
  "The answer runner (answer-runner.ts) takes the same recipient as --recipient and rechecks the owner's delivery policy itself. One handoff file serves one owner's source.",
  "post-many --dry-run reads only the local index and prints the plan; it makes no node call.", "",
].join("\n");

// Existing owner session only: no sign-in, delegation activation, key generation,
// schema initialization, legacy CLI invocation, or profile/host mutation.
export async function runHomeMirror(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    "tc-home": { type: "string" }, profile: { type: "string" }, host: { type: "string" },
    "owner-space": { type: "string" }, "legacy-space": { type: "string" }, file: { type: "string" },
    help: { type: "boolean" }, handoff: { type: "string" },
    "from-index": { type: "string" }, source: { type: "string" }, kinds: { type: "string" }, "dry-run": { type: "boolean" },
  } });
  if (values.help) { process.stdout.write(usage); return; }
  const mode = positionals[0];
  if (mode === "post-many") return runPostMany(values);
  if (positionals.length !== 1 || (mode !== "post" && mode !== "close" && mode !== "watch") || !values["tc-home"] || !values.profile || !values.file || (mode === "watch" && !values.handoff)) throw homeMirrorRefusal("Home mirror requires explicit mode, profile, full spaces, input, and watch handoff file");
  const tcHome = values["tc-home"], profile = values.profile, file = values.file;
  const ownerSpace = fullSpace.parse(values["owner-space"]), legacySpace = fullSpace.parse(values["legacy-space"]);
  await withStopSignal(async (signal) => {
    const { ctx, node } = await openOwnerSession({ tcHome, profile, ownerSpace, legacySpace, host: values.host, signal });
    const input: unknown = JSON.parse(await readFile(file, "utf8"));
    if (signal.aborted) return;
    let result: unknown;
    if (mode === "watch") {
      const config = watchInput.parse(input);
      const local = await openHandoff(values.handoff!);
      try {
        const initialized = await initializeFeedHandoff(local.handle);
        if (!initialized.ok) throw new Error("Local durable handoff initialization failed");
        try {
          await watchHomeMirrors(ctx, { sourceId: config.sourceId, recipient: config.recipient, hooks: node.hooks,
            handoff: local.handle, signal, renewalSeconds: config.renewalSeconds,
            deliver: (response) => runExternal(config.runner, response, signal) });
        } catch (error) {
          if (!(signal.aborted && error !== null && typeof error === "object" && "code" in error && error.code === "ABORTED")) throw error;
        }
        result = { stopped: true };
      } finally { local.close(); }
    } else result = mode === "post" ? await publishHomeMirror(ctx, input) : await closeHomeMirror(ctx, identity.parse(input));
    process.stdout.write(`${JSON.stringify({ operation: mode, result })}\n`);
  });
}

type Values = { [key: string]: string | boolean | undefined };

/** The open inventory from roci-board's index, mirrored in one process; `--dry-run` reads only the index. */
async function runPostMany(values: Values): Promise<void> {
  const index = values["from-index"], source = values.source, ownerSpace = values["owner-space"], legacySpace = values["legacy-space"];
  if (typeof index !== "string" || typeof source !== "string" || typeof ownerSpace !== "string" || typeof legacySpace !== "string" ||
    !fullSpace.safeParse(ownerSpace).success || !fullSpace.safeParse(legacySpace).success) throw homeMirrorRefusal("Home mirror inventory requires a board index, a source and full spaces");
  const kinds = parseInventoryKinds(typeof values.kinds === "string" ? values.kinds : undefined);
  const { rows, skipped } = readBoardIndex(index, kinds);
  const now = Date.now();
  if (values["dry-run"] === true) {
    const plan = inventoryPlan(rows, now);
    process.stdout.write(`${JSON.stringify({ operation: "post-many", dryRun: true, kinds, planned: plan.items.length, items: plan.items, skipped: [...skipped, ...plan.refused] })}\n`);
    return;
  }
  if (typeof values["tc-home"] !== "string" || typeof values.profile !== "string") throw homeMirrorRefusal("Home mirror inventory requires a board index, a source and full spaces");
  const tcHome = values["tc-home"], profile = values.profile, host = typeof values.host === "string" ? values.host : undefined;
  const items = await withStopSignal(async (signal) => {
    const { ctx } = await openOwnerSession({ tcHome, profile, ownerSpace, legacySpace, host, signal });
    return postMany(ctx, { sourceId: source, label: source, rows, now });
  });
  const count = (outcome: string) => items.filter((item) => item.outcome === outcome).length;
  process.stdout.write(`${JSON.stringify({ operation: "post-many", dryRun: false, kinds, posted: count("posted"), already: count("already"), changed: count("changed"), refused: count("refused"), items, skipped })}\n`);
  if (count("refused")) process.exitCode = 1;
}

async function openHandoff(path: string): Promise<{ handle: FeedDatabase; close(): void }> {
  if (!("Bun" in globalThis)) throw new Error("Home mirror watch requires Bun SQLite");
  if (path === ":memory:" || path.startsWith("file:")) throw Object.assign(new Error("Home mirror handoff requires a persistent file path"), { code: "INVALID_INPUT" });
  // A directory created here holds only the ledger: owner-only, whatever the umask.
  const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (created !== undefined) await chmod(dirname(path), 0o700);
  const { Database } = await import("bun:sqlite");
  const database = new Database(path);
  try {
    await chmod(path, 0o600);
    database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  } catch { database.close(); throw new Error("Local durable handoff unavailable"); }
  const failed = (aborted = false): Result<never> => ({ ok: false, error: {
    code: aborted ? "ABORTED" : "SQL_ERROR", message: "Local durable handoff operation failed", service: "sql",
  } });
  const run = (sql: string, params: SqlValue[] = []) => {
    const value = database.query(sql).run(...params);
    return { changes: Number(value.changes), lastInsertRowId: Number(value.lastInsertRowid) };
  };
  const handle: FeedDatabase = {
    query: async <T>(sql: string, params: SqlValue[] = [], options?: { signal?: AbortSignal }) => {
      if (options?.signal?.aborted) return failed(true);
      try { const query = database.query(sql), rows = query.values(...params) as T[][]; return { ok: true, data: { columns: query.columnNames, rows, rowCount: rows.length } }; }
      catch { return failed(); }
    },
    execute: async (sql, params, options) => {
      if (options?.signal?.aborted) return failed(true);
      try { return { ok: true, data: run(sql, params) }; } catch { return failed(); }
    },
    batch: async (statements, options) => {
      if (options?.signal?.aborted) return failed(true);
      try {
        database.exec("BEGIN IMMEDIATE");
        const results = statements.map((statement) => run(statement.sql, statement.params));
        database.exec("COMMIT"); return { ok: true, data: { results } };
      } catch {
        try { database.exec("ROLLBACK"); } catch { /* BEGIN may have failed. */ }
        return failed();
      }
    },
  };
  return { handle, close: () => database.close() };
}

function runExternal(argv: readonly [string, ...string[]], input: FeedResponse, signal: AbortSignal): Promise<"delivered" | "unconfirmed"> {
  if (signal.aborted || (input.dispatchBefore !== undefined && input.dispatchBefore !== null &&
    (!Number.isFinite(Date.parse(input.dispatchBefore)) || Date.now() >= Date.parse(input.dispatchBefore)))) return Promise.resolve("unconfirmed");
  const response = projectFeedResponseNotification(input);
  return new Promise((resolve) => {
    let settled = false, interrupted = false, failed = false;
    let stop: (() => void) | undefined;
    const finish = (state: "delivered" | "unconfirmed") => {
      if (settled) return;
      settled = true; if (stop) signal.removeEventListener("abort", stop); resolve(state);
    };
    try {
      // No shell interpolation and no forwarding of private runner stdout/stderr.
      const child = spawn(argv[0], argv.slice(1), { shell: false, stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", () => { failed = true; finish("unconfirmed"); });
      child.stdin.on("error", () => { failed = true; });
      child.once("close", (code, exitSignal) => finish(!interrupted && !failed && code === 0 && exitSignal === null ? "delivered" : "unconfirmed"));
      stop = () => { interrupted = true; child.kill("SIGKILL"); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop(); else child.stdin.end(`${JSON.stringify(response)}\n`);
    } catch { finish("unconfirmed"); }
  });
}

if (import.meta.main) {
  try { await runHomeMirror(process.argv.slice(2)); }
  catch (error) {
    const diagnostic = homeMirrorDiagnostic(error);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    process.exitCode = diagnostic.exitCode;
  }
}
