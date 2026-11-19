import { describe, expect, it } from "bun:test";

// The share-creation tests with chat sharing enabled need chatSharing mocked.
// Bun's mock.module is process-wide, so they run in a child process.
describe("tinychat share links with chat sharing enabled", () => {
  it("passes in an isolated bun test process", async () => {
    const child = Bun.spawn([process.execPath, "test", "./src/lib/tinychatShareLinks.enabled.fixture.ts"], {
      cwd: new URL("../../", import.meta.url).pathname,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = stdout + stderr;
    expect({ code, ranTests: /\b[1-9]\d* pass\b/.test(output), failed: /\b[1-9]\d* fail\b/.test(output) }).toEqual({
      code: 0,
      ranTests: true,
      failed: false,
    });
  });
});
