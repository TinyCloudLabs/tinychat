/**
 * Patch TinyCloud's generated browser WASM initializer to use the current
 * wasm-bindgen object-shaped init API. The published @tinycloud/web-sdk bundle
 * still calls the initializer with the compiled module directly, which emits:
 * "using deprecated parameters for the initialization function; pass a single object instead"
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const deprecatedWasmInitWarning =
  "using deprecated parameters for the initialization function; pass a single object instead";
const deprecatedWasmInitWarningBranch = `:console.warn("${deprecatedWasmInitWarning}")`;

const bundledWebSdkStart =
  "return function(A){return Y=A.exports,s=null,a=null,Y}(C)}(function(A,g,I,Q){";
const bundledWebSdkStartPatched =
  "return function(A){return Y=A.exports,s=null,a=null,Y}(C)}({module_or_path:function(A,g,I,Q){";
const bundledWebSdkEnd = "void 0)).then(function(){Y.initPanicHook()});";
const bundledWebSdkEndPatched = "void 0)}).then(function(){Y.initPanicHook()});";

const directWasmInit = `var initialized = __wbg_init(wasm()).then(function () {
    return initPanicHook();
});`;
const directWasmInitPatched = `var initialized = __wbg_init({ module_or_path: wasm() }).then(function () {
    return initPanicHook();
});`;

export function patchTinyCloudWasmInit(content) {
  let patched = content;

  if (patched.includes(bundledWebSdkStart) && patched.includes(bundledWebSdkEnd)) {
    patched = patched
      .replace(bundledWebSdkStart, bundledWebSdkStartPatched)
      .replace(bundledWebSdkEnd, bundledWebSdkEndPatched);
  }

  if (patched.includes(directWasmInit)) {
    patched = patched.replace(directWasmInit, directWasmInitPatched);
  }

  if (patched.includes(deprecatedWasmInitWarningBranch)) {
    patched = patched.replaceAll(deprecatedWasmInitWarningBranch, ":void 0");
  }

  return {
    content: patched,
    changed: patched !== content,
  };
}

function resolvePackageJson(packageName, resolver = require) {
  try {
    return resolver.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function resolvePackageFile(packageName, relativePath, resolver = require) {
  const packageJson = resolvePackageJson(packageName, resolver);
  return packageJson ? resolve(dirname(packageJson), relativePath) : null;
}

function patchFile(filePath) {
  if (!filePath || !existsSync(filePath)) {
    return "missing";
  }

  const content = readFileSync(filePath, "utf8");
  const result = patchTinyCloudWasmInit(content);
  if (!result.changed) {
    return "unchanged";
  }

  writeFileSync(filePath, result.content, "utf8");
  return "patched";
}

function readRootWorkspaces(root) {
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (Array.isArray(packageJson.workspaces)) {
      return packageJson.workspaces;
    }

    if (Array.isArray(packageJson.workspaces?.packages)) {
      return packageJson.workspaces.packages;
    }
  } catch {
    return [];
  }

  return [];
}

function expandWorkspacePattern(root, pattern) {
  const parts = pattern.split("/");
  const paths = [root];

  for (const part of parts) {
    const nextPaths = [];
    for (const currentPath of paths) {
      if (part === "*") {
        if (!existsSync(currentPath)) {
          continue;
        }

        for (const entry of readdirSync(currentPath)) {
          const entryPath = join(currentPath, entry);
          if (statSync(entryPath).isDirectory()) {
            nextPaths.push(entryPath);
          }
        }
      } else {
        nextPaths.push(join(currentPath, part));
      }
    }
    paths.splice(0, paths.length, ...nextPaths);
  }

  return paths;
}

function findViteDependencyCaches(root) {
  const caches = new Set([join(root, "node_modules/.vite")]);

  for (const workspace of readRootWorkspaces(root)) {
    for (const workspacePath of expandWorkspacePattern(root, workspace)) {
      caches.add(join(workspacePath, "node_modules/.vite"));
    }
  }

  return [...caches].filter((cachePath) => existsSync(cachePath));
}

function fileContainsAnyMarker(filePath, markers) {
  try {
    const content = readFileSync(filePath, "utf8");
    return markers.some((marker) => content.includes(marker));
  } catch {
    return false;
  }
}

function directoryContainsAnyMarker(directoryPath, markers) {
  for (const entry of readdirSync(directoryPath)) {
    const entryPath = join(directoryPath, entry);
    const stats = statSync(entryPath);

    if (stats.isDirectory()) {
      if (directoryContainsAnyMarker(entryPath, markers)) {
        return true;
      }
    } else if (stats.isFile() && fileContainsAnyMarker(entryPath, markers)) {
      return true;
    }
  }

  return false;
}

export function removeStaleViteDependencyCaches(root = repoRoot) {
  const staleMarkers = [deprecatedWasmInitWarning, bundledWebSdkStart, directWasmInit];
  const removed = [];

  for (const cachePath of findViteDependencyCaches(root)) {
    if (!directoryContainsAnyMarker(cachePath, staleMarkers)) {
      continue;
    }

    rmSync(cachePath, { force: true, recursive: true });
    removed.push(cachePath);
  }

  return removed;
}

export function patchInstalledTinyCloudWebSdk() {
  const webSdkPackageJson = resolvePackageJson("@tinycloud/web-sdk");
  const webSdkRequire = webSdkPackageJson ? createRequire(webSdkPackageJson) : require;

  return [
    resolvePackageFile("@tinycloud/web-sdk", "dist/index.mjs"),
    resolvePackageFile("@tinycloud/web-sdk", "dist/index.cjs"),
    resolvePackageFile("@tinycloud/web-sdk-wasm", "dist/index.js", webSdkRequire),
  ].map((filePath) => ({
    filePath,
    status: patchFile(filePath),
  }));
}

function main() {
  const patchedFiles = patchInstalledTinyCloudWebSdk();
  const removedViteCaches = removeStaleViteDependencyCaches();

  for (const { filePath, status } of patchedFiles) {
    if (status === "patched") {
      console.log(`[fix-web-wasm-init] Patched: ${filePath}`);
    }
  }

  for (const cachePath of removedViteCaches) {
    console.log(`[fix-web-wasm-init] Removed stale Vite cache: ${cachePath}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
