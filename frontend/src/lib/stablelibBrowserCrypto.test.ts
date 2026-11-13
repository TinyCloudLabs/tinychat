import { afterAll, describe, expect, spyOn, test } from "bun:test";
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

/** A browser build of `source` with the app's plugin order (vite.config.ts): this plugin, then the polyfills whose
 *  `crypto` alias it overrides. Returns the bundle's file and the modules in it. */
async function browserBuild(name: string, source: string): Promise<{ file: string; modules: string[] }> {
  const entry = path.join(dir, `${name}.entry.js`);
  writeFileSync(entry, source);
  const output = (await build({
    configFile: false,
    logLevel: "silent",
    root: dir,
    plugins: [stablelibBrowserCrypto(), nodePolyfills({ globals: { Buffer: true, process: true, global: true } })],
    build: { write: false, minify: false, lib: { entry, formats: ["es"], fileName: name } },
  })) as Rollup.RollupOutput[];
  const chunk = output[0].output.find((item): item is Rollup.OutputChunk => item.type === "chunk" && item.isEntry)!;
  // Each bundle gets its own file, so each import evaluates @stablelib/random afresh.
  const file = path.join(dir, `${name}.bundle.mjs`);
  writeFileSync(file, chunk.code);
  return { file, modules: Object.keys(chunk.modules) };
}

const CRYPTO_BROWSERIFY = /[\\/]crypto-browserify[\\/]/;
const STABLELIB_ENTRY = `export { randomBytes } from ${JSON.stringify(stablelibRandom)};\n`;
type RandomBytes = { randomBytes: (length: number) => Uint8Array };

describe("@stablelib/random in a browser build", () => {
  test("draws its bytes from crypto.getRandomValues, without crypto-browserify", async () => {
    const { file, modules } = await browserBuild("with-crypto", STABLELIB_ENTRY);
    expect(modules.filter((id) => CRYPTO_BROWSERIFY.test(id))).toEqual([]);
    const getRandomValues = spyOn(globalThis.crypto, "getRandomValues");
    try {
      const { randomBytes } = (await import(pathToFileURL(file).href)) as RandomBytes;
      expect(randomBytes(32)).toHaveLength(32);
      expect(getRandomValues.mock.calls.some(([array]) => (array as Uint8Array).length === 32)).toBe(true);
    } finally {
      getRandomValues.mockRestore();
    }
  }, 60_000);

  test("throws without crypto.getRandomValues instead of falling back to another source", async () => {
    const { file } = await browserBuild("without-crypto", STABLELIB_ENTRY);
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
    try {
      const { randomBytes } = (await import(pathToFileURL(file).href)) as RandomBytes;
      expect(() => randomBytes(32)).toThrow("System random byte generator is not available.");
    } finally {
      Object.defineProperty(globalThis, "crypto", original);
    }
  }, 60_000);
});

test("any other importer of crypto keeps the crypto-browserify polyfill", async () => {
  const { modules } = await browserBuild("other-importer", `export { randomBytes } from "crypto";\n`);
  expect(modules.some((id) => CRYPTO_BROWSERIFY.test(id))).toBe(true);
}, 60_000);
