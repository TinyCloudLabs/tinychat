import { expect, test } from "bun:test";

test("share links UI with sharing enabled runs in an isolated process", async () => {
  const child = Bun.spawn([process.execPath, "test", "./src/chat/OwnedShareLinks.enabled.fixture.tsx"], {
    cwd: new URL("../../", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, ranTests: /\b[1-9]\d* pass\b/.test(stdout + stderr), failed: /\b[1-9]\d* fail\b/.test(stdout + stderr) }).toEqual({
    code: 0, ranTests: true, failed: false,
  });
});
