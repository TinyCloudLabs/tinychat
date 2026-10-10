// Asserts a built dist/ keeps the Soft-skin recorder out of the web precache while VITE_EXO_RECORDER_FINAL is unset
// (and in it when the flag is on). It builds nothing:
//   bun run build                                   (flag unset)
//   bun scripts/flag-off-bundle-check.ts dist       (exit 1 and a list of problems on any breach)
//   VITE_EXO_RECORDER_FINAL=true bun run build && bun scripts/flag-off-bundle-check.ts dist --flag on
// The `final-*` naming and the precache rule live in vite.config.ts (FINAL_ONLY_MODULE, workbox.globIgnores).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const FINAL_CHUNK = /(?:^|\/)final-[^/]+\.js$/;
const STATIC_IMPORT = /(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+\.js)["']/g;
const NEVER_PRECACHED = [/franken_markdown_bg[^/]*\.wasm$/, /(?:^|\/)tauri-window-[^/]+\.js$/];

/** The urls the service worker precaches, as Workbox lists them in dist/sw.js. */
export function precacheUrls(sw: string): string[] {
  return [...sw.matchAll(/\{url:"([^"]+)"/g)].map((match) => match[1]!);
}

/** The chunks index.html loads before anything runs, and every chunk those import statically. */
export function eagerChunks(dist: string): Set<string> {
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  const roots = [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1]!.replace(/^\//, ""));
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(path.join(dist, file), "utf8");
    for (const match of source.matchAll(STATIC_IMPORT)) queue.push(path.posix.join(path.posix.dirname(file), match[1]!));
  }
  return seen;
}

/** CSS that only `final-*` chunks name: Rollup gives it no prefix, so the references say whose it is. */
export function finalOnlyCss(dist: string): string[] {
  const assets = path.join(dist, "assets");
  const files = readdirSync(assets);
  const referrers = new Map<string, string[]>();
  for (const file of files.filter((name) => name.endsWith(".js"))) {
    const source = readFileSync(path.join(assets, file), "utf8");
    for (const css of files.filter((name) => name.endsWith(".css") && source.includes(name)))
      referrers.set(css, [...(referrers.get(css) ?? []), file]);
  }
  const html = readFileSync(path.join(dist, "index.html"), "utf8");
  return [...referrers]
    .filter(([css, by]) => !html.includes(css) && by.every((file) => FINAL_CHUNK.test(file)))
    .map(([css]) => `assets/${css}`);
}

export function checkDist(dist: string, flag: "on" | "off"): string[] {
  const problems: string[] = [];
  const swPath = path.join(dist, "sw.js");
  if (!existsSync(swPath)) return [`${swPath} is missing: build the app first`];
  const precached = new Set(precacheUrls(readFileSync(swPath, "utf8")));
  const assets = readdirSync(path.join(dist, "assets"));
  const finalJs = assets.filter((name) => FINAL_CHUNK.test(name)).map((name) => `assets/${name}`);
  const finalCss = finalOnlyCss(dist);
  if (finalJs.length === 0) problems.push("no final-* chunk in dist/assets: the naming rule in vite.config.ts no longer matches anything");

  for (const url of precached) {
    if (NEVER_PRECACHED.some((pattern) => pattern.test(url))) problems.push(`${url} is precached; it is cached at run time or never`);
  }
  if (flag === "off") {
    for (const url of [...finalJs, ...finalCss]) {
      if (precached.has(url)) problems.push(`${url} is precached with the recorder flag off`);
    }
    for (const file of eagerChunks(dist)) {
      if (FINAL_CHUNK.test(file)) problems.push(`${file} loads eagerly (index.html imports it statically) with the recorder flag off`);
    }
  } else {
    for (const url of [...finalJs, ...finalCss]) {
      if (!precached.has(url)) problems.push(`${url} is missing from the precache with the recorder flag on`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flagAt = args.indexOf("--flag");
  const flag = flagAt >= 0 ? args[flagAt + 1] : "off";
  if (flag !== "on" && flag !== "off") throw new Error("--flag must be on or off");
  const dist = path.resolve(args.find((arg, index) => !arg.startsWith("--") && index !== flagAt + 1) ?? "dist");
  const problems = checkDist(dist, flag);
  if (problems.length > 0) {
    console.error(`flag-${flag} bundle check failed for ${dist}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`flag-${flag} bundle check passed for ${dist}`);
}
