import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE = "SYNTHETIC2499PRIVATEBODY";
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function execute(args: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "home-mirror-errors-"));
  cleanup.push(directory);
  const home = join(directory, "home"), tcHome = join(home, ".tinycloud");
  await mkdir(tcHome, { recursive: true, mode: 0o700 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "run.ts"), ...args], {
    env: { ...process.env, HOME: home, TC_HOME: tcHome }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

test("missing required inputs identify the input failure without implying delivery", async () => {
  const result = await execute([]);
  expect(result.exit).toBe(2);
  expect(result.stdout).toBe("");
  const diagnostic = JSON.parse(result.stderr);
  expect(diagnostic).toMatchObject({ error: { name: "Error", code: "INVALID_INPUT", step: "arguments" }, delivery: "not-confirmed" });
});

test("an unknown option retains its class and code without reflecting the option value", async () => {
  const result = await execute([`--${PRIVATE}`]);
  expect(result.exit).toBe(2);
  expect(result.stderr).not.toContain(PRIVATE);
  expect(JSON.parse(result.stderr)).toMatchObject({ error: { name: "TypeError", code: "ERR_PARSE_ARGS_UNKNOWN_OPTION", step: "arguments" }, delivery: "not-confirmed" });
});

test("SQL diagnostics keep safe code/status but discard body, SQL and nested causes", async () => {
  const bridge = await import("./bridge");
  const diagnostic = bridge.homeMirrorDiagnostic({ code: "SQL_ERROR", service: "sql", message: PRIVATE, cause: new Error(PRIVATE), meta: { status: 400, sql: PRIVATE, responseBody: PRIVATE } });
  expect(diagnostic).toMatchObject({ error: { name: "ServiceError", code: "SQL_ERROR", message: "SQL operation failed", status: 400 }, delivery: "not-confirmed", exitCode: 1 });
  expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
});

test("a transient failure remains unconfirmed and requires manual reconciliation", async () => {
  const { homeMirrorDiagnostic } = await import("./bridge");
  const diagnostic = homeMirrorDiagnostic({ code: "NETWORK_ERROR", service: "sql", message: PRIVATE, meta: { status: 503, body: PRIVATE } });
  expect(diagnostic).toMatchObject({ error: { code: "NETWORK_ERROR", status: 503 }, exitCode: 6, delivery: "not-confirmed", retry: "manual-reconciliation-required" });
  expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
});

test("unknown error messages, names, codes and metadata are not reflected", async () => {
  const { homeMirrorDiagnostic } = await import("./bridge");
  const error = Object.assign(new Error(PRIVATE), { name: PRIVATE, code: PRIVATE, cause: new Error(PRIVATE), meta: { status: PRIVATE } });
  const diagnostic = homeMirrorDiagnostic(error);
  expect(diagnostic).toMatchObject({ error: { name: "Error" }, delivery: "not-confirmed" });
  expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
});

test("an unclassified runtime failure is not reported as bad input", async () => {
  const { homeMirrorDiagnostic } = await import("./bridge");
  const diagnostic = homeMirrorDiagnostic(new Error(PRIVATE));
  expect(diagnostic.exitCode).toBe(1);
  expect(diagnostic.error.code).not.toBe("INVALID_INPUT");
  expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
});

test("canonical busy and request-timeout codes remain transient without HTTP metadata", async () => {
  const { homeMirrorDiagnostic } = await import("./bridge");
  for (const code of ["NODE_BUSY", "REQUEST_TIMEOUT"]) {
    const diagnostic = homeMirrorDiagnostic({ code, service: "sql", message: PRIVATE });
    expect(diagnostic).toMatchObject({ error: { code }, exitCode: 6, delivery: "not-confirmed", retry: "manual-reconciliation-required" });
    expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
  }
});

test("an explicit unknown write outcome is never classified as a transient retry", async () => {
  const { homeMirrorDiagnostic } = await import("./bridge");
  const diagnostic = homeMirrorDiagnostic({ code: "OUTCOME_UNKNOWN", service: "sql", message: PRIVATE, meta: { status: 503 } });
  expect(diagnostic).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" }, exitCode: 1, delivery: "not-confirmed", retry: "manual-reconciliation-required" });
  expect(JSON.stringify(diagnostic)).not.toContain(PRIVATE);
});
