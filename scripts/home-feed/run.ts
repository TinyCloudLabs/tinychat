import { spawn } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { z } from "zod";
import type { Result, SqlValue } from "@tinycloud/sdk-services";
import { initializeFeedHandoff, projectFeedResponseNotification } from "@tinycloud/sdk-services/feed";
import type { FeedDatabase, FeedResponse } from "@tinycloud/sdk-services/feed";
import { loadProfile } from "../agent-sync/fireflies";
import { closeHomeMirror, publishHomeMirror, watchHomeMirrors } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";

const space = z.string().regex(/^tinycloud:[^\s]+:[^\s]+$/);
const identity = z.object({ sourceId: z.string().min(1), cardId: z.string().uuid(), revision: z.number().int().positive().safe(), issuanceId: z.string().min(1) }).strict();
const watchInput = z.object({ sourceId: z.string().min(1), recipient: z.string().min(1).refine((value) => value !== "*"), runner: z.array(z.string().min(1)).nonempty(), renewalSeconds: z.number().int().min(60).max(300).optional() }).strict();
const usage = "bun scripts/home-feed/run.ts post|close|watch --tc-home DIR --profile NAME --owner-space FULL_URI --legacy-space FULL_URI --file JSON [--host URL] [--handoff SQLITE_FILE for watch]\nWatch JSON: {sourceId,recipient,runner:[executable,...argv],renewalSeconds?}. Runner exit zero must mean durable acceptance of the full response ID; execution must recheck dispatchBefore.\n";

export function normalizeHomeMirrorHost(value: string): string {
  const host = new URL(value);
  if (!["http:", "https:"].includes(host.protocol) || host.username || host.password || host.search || host.hash) throw new Error("Invalid node host");
  return host.href.replace(/\/+$/, "");
}

// Existing owner session only: no sign-in, delegation activation, key generation,
// schema initialization, legacy CLI invocation, or profile/host mutation.
export async function runHomeMirror(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    "tc-home": { type: "string" }, profile: { type: "string" }, host: { type: "string" },
    "owner-space": { type: "string" }, "legacy-space": { type: "string" }, file: { type: "string" },
    help: { type: "boolean" }, handoff: { type: "string" },
  } });
  if (values.help) { process.stdout.write(usage); return; }
  const mode = positionals[0];
  if (positionals.length !== 1 || (mode !== "post" && mode !== "close" && mode !== "watch") || !values["tc-home"] || !values.profile || !values.file || (mode === "watch" && !values.handoff)) throw new Error("Home mirror requires explicit mode, profile, full spaces, input, and watch handoff file");
  const ownerSpaceId = space.parse(values["owner-space"]), legacySpaceId = space.parse(values["legacy-space"]);
  const profile = loadProfile(values["tc-home"], values.profile);
  if (profile.spaceId !== ownerSpaceId || (profile.expiresAt !== null && (!Number.isFinite(Date.parse(profile.expiresAt)) || Date.parse(profile.expiresAt) <= Date.now()))) throw new Error("Existing owner session is unavailable");
  const host = normalizeHomeMirrorHost(values.host ?? profile.host);
  const input: unknown = JSON.parse(await readFile(values.file, "utf8"));
  const signal = new AbortController();
  const abort = () => signal.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const node = new TinyCloudNode({ host, includeAccountRegistryPermissions: false });
    await node.restoreSession({ ...profile.session, tinycloudHosts: [host] });
    if (signal.signal.aborted) return;
    const ctx: HomeMirrorContext = { ownerSpaceId, sql: node.sqlForSpace(ownerSpaceId), legacySpaceId, legacy: node.kvForSpace(legacySpaceId), now: () => new Date().toISOString(), signal: signal.signal };
    let result: unknown;
    if (mode === "watch") {
      const config = watchInput.parse(input);
      const local = await openHandoff(values.handoff!);
      try {
        const initialized = await initializeFeedHandoff(local.handle);
        if (!initialized.ok) throw new Error("Local durable handoff initialization failed");
        try {
          await watchHomeMirrors(ctx, { sourceId: config.sourceId, recipient: config.recipient, hooks: node.hooks,
            handoff: local.handle, signal: signal.signal, renewalSeconds: config.renewalSeconds,
            deliver: (response) => runExternal(config.runner, response, signal.signal) });
        } catch (error) {
          if (!(signal.signal.aborted && error !== null && typeof error === "object" && "code" in error && error.code === "ABORTED")) throw error;
        }
        result = { stopped: true };
      } finally { local.close(); }
    } else result = mode === "post" ? await publishHomeMirror(ctx, input) : await closeHomeMirror(ctx, identity.parse(input));
    process.stdout.write(`${JSON.stringify({ operation: mode, result })}\n`);
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}

async function openHandoff(path: string): Promise<{ handle: FeedDatabase; close(): void }> {
  if (!("Bun" in globalThis)) throw new Error("Home mirror watch requires Bun SQLite");
  if (path === ":memory:" || path.startsWith("file:")) throw new Error("Home mirror handoff requires a persistent file path");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
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
  catch { process.stderr.write("Home mirror operation failed; no delivery success is implied.\n"); process.exitCode = 1; }
}
