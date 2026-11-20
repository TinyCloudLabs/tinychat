import { expect, test } from "bun:test";

test("share links UI with sharing enabled runs in an isolated process", async () => {
  const child = Bun.spawn([process.execPath, "test", "./src/chat/OwnedShareLinks.enabled.fixture.ts"], {
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


test("the Settings share card stays hidden while sharing is paused without reading links", async () => {
  const { installDom } = await import("../test/dom");
  const cleanDom = installDom();
  try {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { OwnedShareLinksCard } = await import("./OwnedShareLinks");
    let reads = 0;
    const tcw = { kv: { list: async () => { reads++; throw new Error("paused list read"); } } } as never;
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<OwnedShareLinksCard tcw={tcw} />); });
      expect(host.textContent).toBe("");
      expect(reads).toBe(0);
    } finally {
      await act(async () => root.unmount());
    }
  } finally {
    cleanDom();
  }
});
