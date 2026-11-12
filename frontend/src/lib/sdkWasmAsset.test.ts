import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { extractInlinedSdkWasm } from "./sdkWasmAsset";

const URL_EXPRESSION = 'new URL("sdk.wasm",import.meta.url)';
const urlFor = () => URL_EXPRESSION;
const decoder = 'function(A,e,t,I){var C=globalThis.atob(t);return r(C,I,!1)}';

describe("extractInlinedSdkWasm", () => {
  test("replaces the decode IIFE with the URL and returns the bytes", () => {
    const code = `X({module_or_path:${decoder}(0,0,"AGFzbQEAAAA=",void 0)}).then(f)`;
    expect(extractInlinedSdkWasm(code, urlFor)).toEqual({
      base64: "AGFzbQEAAAA=",
      code: `X({module_or_path:${URL_EXPRESSION}}).then(f)`,
    });
  });

  test("leaves code without inlined WASM alone", () => {
    expect(extractInlinedSdkWasm('X({module_or_path:new URL("a.wasm",import.meta.url)})', urlFor)).toBeNull();
  });

  test("fails the build on an inlined WASM it can't take out", () => {
    expect(() => extractInlinedSdkWasm('const wasm="AGFzbQEAAAA=";', urlFor)).toThrow(/unrecognised form/);
    expect(() => extractInlinedSdkWasm(`X({module_or_path:${decoder}(0,0,"AGFzbQEAAAA=",imports)})`, urlFor))
      .toThrow(/unrecognised form/);
  });

  test("takes the WASM out of the installed @tinycloud/web-sdk bundle", () => {
    const require = createRequire(import.meta.url);
    const bundle = path.join(path.dirname(require.resolve("@tinycloud/web-sdk/package.json")), "dist/index.mjs");
    const result = extractInlinedSdkWasm(readFileSync(bundle, "utf8"), urlFor)!;
    expect(result).not.toBeNull();
    const bytes = Buffer.from(result.base64, "base64");
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(result.code).toContain(`module_or_path:${URL_EXPRESSION}}`);
    expect(result.code).not.toContain("AGFzbQ");
  });
});
