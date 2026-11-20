import { describe, expect, test } from "bun:test";

import { getPwaState, watchStaleChunks } from "./pwa";

describe("a chunk that no longer exists after a deploy", () => {
  const version = (commit: string | null, ok = true) => async () => ok
    ? new Response(JSON.stringify({ commit }), { headers: { "content-type": "application/json" } })
    : new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });
  const settle = () => { const { promise, resolve } = Promise.withResolvers<void>(); setTimeout(resolve, 0); return promise; };

  test("a failed lazy chunk while this build is still deployed (offline, a blip) offers nothing", async () => {
    const target = new EventTarget();
    const stop = watchStaleChunks({ target, commit: "aaa111", fetch: version("aaa111") });
    target.dispatchEvent(new Event("vite:preloadError"));
    await settle();
    expect(getPwaState().updateReady).toBe(false);
    stop();
    // An origin without a version.json (index.html instead) offers nothing either.
    const other = watchStaleChunks({ target, commit: "aaa111", fetch: version(null, false) });
    target.dispatchEvent(new Event("vite:preloadError"));
    await settle();
    expect(getPwaState().updateReady).toBe(false);
    other();
  });

  test("a failed lazy chunk after another build was deployed offers the Reload", async () => {
    const target = new EventTarget();
    const stop = watchStaleChunks({ target, commit: "aaa111", fetch: version("bbb222") });
    target.dispatchEvent(new Event("vite:preloadError"));
    await settle();
    expect(getPwaState().updateReady).toBe(true);
    stop();
  });
});
