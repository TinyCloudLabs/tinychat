import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("request console and dependency stdout/stderr redact forbidden values at the process boundary", async () => {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "test", resolve(import.meta.dir, "index-wiring.test.ts"),
    "--test-name-pattern", "TC-959 process log canary",
  ], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect(exit).toBe(0);
  expect(stdout).toContain("TC959_CAPTURE_POSITIVE_CONTROL");
  expect(stdout + stderr).not.toContain("TC959_FORBIDDEN_wallet_tenant_capability_transcript");
  const events = stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line));
  const diagnostics = events.filter(event => event.event === "tinychat_request_diagnostic");
  expect(diagnostics).toEqual(["info", "info", "error", "error", "info", "error"].map(level => ({
    event: "tinychat_request_diagnostic", request_id: "12345678-abcd-4abc-8abc-123456789abc", level,
  })));
  const requests = events.filter(event => event.event === "tinychat_request");
  expect(requests).toEqual([{
    event: "tinychat_request", request_id: "12345678-abcd-4abc-8abc-123456789abc",
    method: "GET", route: "/canary/:id", status: 204, duration_ms: expect.any(Number), request_id_replaced: false,
  }]);
});

test.each(["stdout", "stderr"] as const)("preserves unscoped %s write callback overloads", async name => {
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../request-context.ts")).href;
  const source = `
    import assert from "node:assert/strict";
    import { installRequestLogBoundary } from ${JSON.stringify(moduleUrl)};
    const stream = process[${JSON.stringify(name)}];
    async function callbacks(label) {
      const observed = [];
      const finished = Promise.withResolvers();
      stream.write("undefined-encoding\\n", undefined, () => observed.push("undefined-encoding"));
      stream.write("two-arguments\\n", () => observed.push("two-arguments"));
      // The final write callback is an I/O completion barrier, not a guessed timer.
      stream.write("explicit-encoding\\n", "utf8", () => {
        observed.push("explicit-encoding");
        finished.resolve();
      });
      await finished.promise;
      assert.deepEqual(observed, ["undefined-encoding", "two-arguments", "explicit-encoding"], label);
    }
    await callbacks("before boundary installation");
    installRequestLogBoundary();
    await callbacks("after boundary installation");
    console.log("TC959_UNSCOPED_CALLBACKS_PASSED");
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", source], {
    env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ exit, error: exit === 0 ? null : stderr }).toEqual({ exit: 0, error: null });
  expect(stdout).toContain("TC959_UNSCOPED_CALLBACKS_PASSED");
});
