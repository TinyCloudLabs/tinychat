import assert from "node:assert/strict";
import { after, test } from "node:test";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Run with `node --test`: Bun's global deliberately bypasses the worker path.
const bundle = await build({ entryPoints: [new URL("./audioHash.ts", import.meta.url).pathname],
  bundle: true, write: false, format: "esm", platform: "browser" });
// A file URL lets the bundled module resolve its relative worker URL before
// the fake Worker constructor runs. A data: URL throws during URL resolution.
const directory = await mkdtemp(join(tmpdir(), "tinychat-audio-hash-"));
const bundleUrl = pathToFileURL(join(directory, "audioHash.mjs"));
await writeFile(bundleUrl, bundle.outputFiles[0].contents);
const original = { window: globalThis.window, document: globalThis.document, Worker: globalThis.Worker };
globalThis.window = {};
globalThis.document = {};
after(async () => { Object.assign(globalThis, original); await rm(directory, { recursive: true, force: true }); });
const freshModule = (name) => import(`${bundleUrl.href}?${name}`);
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
  let constructions = 0;
  let constructedUrl;
  globalThis.Worker = class { constructor(url) {
    constructions++;
    constructedUrl = url;
    throw new DOMException("blocked", "SecurityError");
  } };
  await assertBothPaths("constructor");
  assert.equal(constructions, 1);
  assert.equal(constructedUrl.protocol, "file:");
  assert.match(constructedUrl.pathname, /\/audioHash\.worker\.ts$/);
});

test("Worker startup error before its first message falls back", { timeout: 2000 }, async () => {
  let posts = 0;
  let errors = 0;
  let terminations = 0;
  globalThis.Worker = class {
    postMessage() { posts++; queueMicrotask(() => { errors++; this.onerror({ message: "worker blocked" }); }); }
    terminate() { terminations++; }
  };
  await assertBothPaths("startup");
  const { audioHasher } = await freshModule("stream-startup");
  const hasher = await audioHasher();
  await hasher.update(bytes.subarray(0, 10));
  await hasher.update(bytes.subarray(10));
  assert.equal(await hasher.digest(), expected);
  assert.equal(posts, 2);
  assert.equal(errors, 2);
  assert.equal(terminations, 2);
});

test("blocked Worker postMessage falls back", { timeout: 2000 }, async () => {
  let posts = 0;
  let terminations = 0;
  globalThis.Worker = class {
    postMessage() { posts++; throw new DOMException("blocked", "SecurityError"); }
    terminate() { terminations++; }
  };
  await assertBothPaths("post-message");
  assert.equal(posts, 1);
  assert.equal(terminations, 1);
});
