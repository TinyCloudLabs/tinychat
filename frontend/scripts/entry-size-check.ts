// Entry-chunk size budget (TC-2882). The app's whole startup JS is the module index.html loads: every byte of it is
// fetched, parsed and evaluated before the first paint on every launch (on iOS it was one 10 MB chunk and a
// 216–279 ms main-thread block). Screens load from their own chunks (src/shell/lazyTab.tsx) and the TinyCloud SDK's
// WASM is a separate asset (src/lib/sdkWasmAsset.ts); this fails the build when either regresses.
//
// Run after `vite build`: bun frontend/scripts/entry-size-check.ts [dist dir, default frontend/dist]
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Minified bytes. Raise it only with a reason in the PR: what the entry chunk now needs at boot that it can't load later. */
// Temporary SDK graph allowance: +178,625 bytes; wrapper +301. Details: TC-2872
// Restore the 7,600,000-byte ceiling after the SDK root split. Details: TC-2935
// Canonical run 43444944081: beta.26 +327; lease bootstrap +415. Details: TC-2872
const ENTRY_CHUNK_BUDGET = 7_731_905;

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../dist"));
const html = readFileSync(path.join(dist, "index.html"), "utf8");
const src = /<script type="module"[^>]*\ssrc="\/([^"]+\.js)"/.exec(html)?.[1];
if (!src) throw new Error(`${dist}/index.html loads no module script`);
const file = path.join(dist, src);
const size = statSync(file).size;
const inlinedWasm = readFileSync(file, "latin1").includes('"AGFzbQ');
console.log(`Entry chunk ${src}: ${size.toLocaleString("en")} bytes (budget ${ENTRY_CHUNK_BUDGET.toLocaleString("en")})`);
if (inlinedWasm) {
  console.log("::error title=Entry chunk carries inlined WASM::A WebAssembly binary is inlined as base64 in the entry chunk; load it as an asset (see src/lib/sdkWasmAsset.ts).");
  process.exit(1);
}
if (size > ENTRY_CHUNK_BUDGET) {
  console.log(`::error title=Entry chunk over budget::${src} is ${size.toLocaleString("en")} bytes, over the ${ENTRY_CHUNK_BUDGET.toLocaleString("en")}-byte budget. Load what boot doesn't need lazily (a dynamic import), or raise ENTRY_CHUNK_BUDGET in frontend/scripts/entry-size-check.ts with the reason.`);
  process.exit(1);
}
