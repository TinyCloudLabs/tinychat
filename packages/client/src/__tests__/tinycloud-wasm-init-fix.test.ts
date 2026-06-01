import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  patchTinyCloudWasmInit,
  removeStaleViteDependencyCaches,
} from "../../scripts/fix-web-wasm-init.mjs";

describe("patchTinyCloudWasmInit", () => {
  test("wraps the bundled web-sdk wasm module in the object-shaped initializer", () => {
    const input =
      'return function(A){return Y=A.exports,s=null,a=null,Y}(C)}(function(A,g,I,Q){return E(i,Q,!1)}(0,0,"wasm",void 0)).then(function(){Y.initPanicHook()});';

    const result = patchTinyCloudWasmInit(input);

    expect(result.changed).toBe(true);
    expect(result.content).toContain(
      "return function(A){return Y=A.exports,s=null,a=null,Y}(C)}({module_or_path:function(A,g,I,Q){",
    );
    expect(result.content).toContain('}(0,0,"wasm",void 0)}).then(function(){Y.initPanicHook()});');
  });

  test("wraps the direct web-sdk-wasm module in the object-shaped initializer", () => {
    const input = `var initialized = __wbg_init(wasm()).then(function () {
    return initPanicHook();
});`;

    const result = patchTinyCloudWasmInit(input);

    expect(result.changed).toBe(true);
    expect(result.content).toContain(
      "var initialized = __wbg_init({ module_or_path: wasm() }).then(function () {",
    );
  });

  test("removes the generated wasm-bindgen deprecation warning branch", () => {
    const input =
      'Object.getPrototypeOf(A)===Object.prototype?({module_or_path:A}=A):console.warn("using deprecated parameters for the initialization function; pass a single object instead")';

    const result = patchTinyCloudWasmInit(input);

    expect(result.changed).toBe(true);
    expect(result.content).not.toContain(
      "using deprecated parameters for the initialization function",
    );
    expect(result.content).toContain("Object.getPrototypeOf(A)===Object.prototype");
  });

  test("removes stale generated frontend Vite dependency caches with the deprecated wasm init warning", () => {
    const root = mkdtempSync(join(tmpdir(), "generated-app-wasm-init-"));

    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          workspaces: ["apps/generated/frontend", "packages/client"],
        }),
      );

      const staleCache = join(root, "apps/generated/frontend/node_modules/.vite");
      const staleFile = join(staleCache, "deps/@tinycloud_web-sdk.js");
      mkdirSync(join(staleCache, "deps"), { recursive: true });
      writeFileSync(
        staleFile,
        'console.warn("using deprecated parameters for the initialization function; pass a single object instead");',
      );

      const packageCache = join(root, "packages/client/node_modules/.vite");
      const packageCacheFile = join(packageCache, "deps/other.js");
      mkdirSync(join(packageCache, "deps"), { recursive: true });
      writeFileSync(packageCacheFile, "console.log('fresh cache');");

      const removed = removeStaleViteDependencyCaches(root);

      expect(removed).toEqual([staleCache]);
      expect(readFileSync(packageCacheFile, "utf8")).toBe("console.log('fresh cache');");
      expect(() => readFileSync(staleFile, "utf8")).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
