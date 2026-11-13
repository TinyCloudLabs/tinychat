import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Rollup } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { stablelibBrowserCrypto } from "./stablelibBrowserCrypto";

// The copy of @stablelib/random the SDK reaches at boot: @tinycloud/sdk-core -> siwe -> @stablelib/random.
const sdkCore = createRequire(import.meta.url).resolve("@tinycloud/sdk-core");
const siwe = createRequire(sdkCore).resolve("siwe");
const stablelibRandom = createRequire(siwe).resolve("@stablelib/random");

const dir = mkdtempSync(path.join(tmpdir(), "stablelib-browser-crypto-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a browser build draws @stablelib/random's bytes from crypto.getRandomValues, without crypto-browserify", async () => {
  const entry = path.join(dir, "entry.js");
  writeFileSync(entry, `export { randomBytes } from ${JSON.stringify(stablelibRandom)};\n`);
  // The app's plugin order (vite.config.ts): this plugin, then the polyfills whose `crypto` alias it overrides.
  const output = (await build({
    configFile: false,
    logLevel: "silent",
    root: dir,
    plugins: [stablelibBrowserCrypto(), nodePolyfills({ globals: { Buffer: true, process: true, global: true } })],
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: "bundle" } },
  })) as Rollup.RollupOutput[];
  const chunk = output[0].output.find((item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry)!;
  expect(Object.keys(chunk.modules).filter((id) => /[\\/]crypto-browserify[\\/]/.test(id))).toEqual([]);

  const bundle = path.join(dir, "bundle.mjs");
  writeFileSync(bundle, chunk.code);
  const getRandomValues = spyOn(globalThis.crypto, "getRandomValues");
  try {
    const { randomBytes } = (await import(pathToFileURL(bundle).href)) as { randomBytes: (length: number) => Uint8Array };
    const bytes = randomBytes(32);
    expect(bytes).toHaveLength(32);
    expect(getRandomValues).toHaveBeenCalled();
    expect(getRandomValues.mock.calls.some(([array]) => (array as Uint8Array).length === 32)).toBe(true);
  } finally {
    getRandomValues.mockRestore();
  }
}, 60_000);
