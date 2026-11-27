// Entry-chunk size budget (TC-2882). The app's whole startup JS is the module index.html loads: every byte of it is
// fetched, parsed and evaluated before the first paint on every launch (on iOS it was one 10 MB chunk and a
// 216–279 ms main-thread block). Screens load from their own chunks (src/shell/lazyTab.tsx) and the TinyCloud SDK's
// WASM is a separate asset (src/lib/sdkWasmAsset.ts); this fails the build when either regresses, or when crypto-browserify
// is back in the entry chunk (src/lib/stablelibBrowserCrypto.ts, TC-2935).
//
// Run after `vite build`: bun frontend/scripts/entry-size-check.ts [dist dir, default frontend/dist]
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Minified bytes. Raise it only with a reason in the PR: what the entry chunk now needs at boot that it can't load later. */
// 7,641,000 since the speaker-names branch: voice-note saves and transcript writes now try again by themselves after
// an outage, and the Mac's local transcription job can run Parakeet. That logic lives in the save, sync and
// transcription modules the app starts with (about 8 KB after everything that could load later was moved out).
// 7,645,000: release 5's changes together measure 7,642,760 bytes at boot, 1,760 over the 7,641,000 before it. The
// extra 4,000 bytes are headroom for that release; the lazy-loading work that wins them back is TC-4328.
// 7,652,000: the one-at-a-time Granola delete (TC-4413) measures 7,648,383 bytes at boot, 3,383 over the 7,645,000 before it.
// The marker guard in upsertMeeting, the combined-meeting count and the delete sheet sit in the Library and sync modules
// the app starts with. The remaining 3,617 bytes are headroom; the lazy-loading work that wins them back is TC-4328.
// 7,661,000: Fireflies and Google Meet per-item deletion (TC-4414) measures 7,656,967 bytes at boot, 4,967 over
// the 7,652,000 budget. Source-marker guards and the Library delete flow share startup connector modules.
// The remaining 4,033 bytes are headroom; the lazy-loading work that wins them back is TC-4328.
const ENTRY_CHUNK_BUDGET = 7_661_000;

const dist = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "../dist"));
const html = readFileSync(path.join(dist, "index.html"), "utf8");
const src = /<script type="module"[^>]*\ssrc="\/([^"]+\.js)"/.exec(html)?.[1];
if (!src) throw new Error(`${dist}/index.html loads no module script`);
const file = path.join(dist, src);
const size = statSync(file).size;
const entry = readFileSync(file, "latin1");
const inlinedWasm = entry.includes('"AGFzbQ');
// crypto-browserify's own stub message: present whenever its index module is bundled (src/lib/stablelibBrowserCrypto.ts).
const cryptoBrowserify = entry.includes("sorry, createCredentials is not implemented yet");
console.log(`Entry chunk ${src}: ${size.toLocaleString("en")} bytes (budget ${ENTRY_CHUNK_BUDGET.toLocaleString("en")})`);
if (inlinedWasm) {
  console.log("::error title=Entry chunk carries inlined WASM::A WebAssembly binary is inlined as base64 in the entry chunk; load it as an asset (see src/lib/sdkWasmAsset.ts).");
  process.exit(1);
}
if (cryptoBrowserify) {
  console.log("::error title=Entry chunk carries crypto-browserify::The Node crypto polyfill is in the entry chunk; nothing the browser runs at boot needs it (see src/lib/stablelibBrowserCrypto.ts).");
  process.exit(1);
}
if (size > ENTRY_CHUNK_BUDGET) {
  console.log(`::error title=Entry chunk over budget::${src} is ${size.toLocaleString("en")} bytes, over the ${ENTRY_CHUNK_BUDGET.toLocaleString("en")}-byte budget. Load what boot doesn't need lazily (a dynamic import), or raise ENTRY_CHUNK_BUDGET in frontend/scripts/entry-size-check.ts with the reason.`);
  process.exit(1);
}
