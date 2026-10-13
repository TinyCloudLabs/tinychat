import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";

// Run with `node --test`: Bun's global deliberately bypasses the worker path.
const bundle = await build({ entryPoints: [new URL("./audioHash.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "browser" });
const source = Buffer.from(bundle.outputFiles[0].contents).toString("base64");
const original = { window: globalThis.window, document: globalThis.document, Worker: globalThis.Worker };
globalThis.window = {};
globalThis.document = {};
after(() => Object.assign(globalThis, original));
const freshModule = (name) => import(`data:text/javascript;base64,${source}#${name}`);
const bytes = new TextEncoder().encode("the same audio in every hashing mode");
const expected = "0c3c756fb0097966e5471ce2328999ea59df0d400ccf602bd1541654d70abda8";

async function assertBothPaths(name) {
  const { hashAudioBytes, audioHasher } = await freshModule(name);
  assert.equal(await hashAudioBytes(bytes), expected);
  const hasher = await audioHasher();
  await hasher.update(bytes.subarray(0, 7));
  await hasher.update(bytes.subarray(7));
  assert.equal(await hasher.digest(), expected);
}

test("DOM without Worker hashes bytes and chunks on the main thread", async () => {
  globalThis.Worker = undefined;
  await assertBothPaths("missing");
});

test("blocked Worker construction falls back to identical hashes", async () => {
  globalThis.Worker = class { constructor() { throw new DOMException("blocked", "SecurityError"); } };
  await assertBothPaths("constructor");
});

test("Worker startup error before its first message falls back", async () => {
  globalThis.Worker = class {
    postMessage() { queueMicrotask(() => this.onerror({ message: "worker blocked" })); }
    terminate() {}
  };
  await assertBothPaths("startup");
  const { audioHasher } = await freshModule("stream-startup");
  const hasher = await audioHasher();
  await hasher.update(bytes.subarray(0, 10));
  await hasher.update(bytes.subarray(10));
  assert.equal(await hasher.digest(), expected);
});

test("blocked Worker postMessage falls back", async () => {
  globalThis.Worker = class {
    postMessage() { throw new DOMException("blocked", "SecurityError"); }
    terminate() {}
  };
  await assertBothPaths("post-message");
});
