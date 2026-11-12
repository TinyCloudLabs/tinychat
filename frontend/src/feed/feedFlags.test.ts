import { expect, test } from "bun:test";
import { changedFlags, DEFAULT_FEED_FLAGS, FEED_FLAGS_STORAGE_KEY, previewHost, resolveFeedFlags } from "./feedFlags";

function memory(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
const PREVIEW = "3f2a91c0.tinychat.pages.dev";

test("with nothing set, every switch is the approved feed's", () => {
  expect(resolveFeedFlags({ env: {}, hostname: PREVIEW, search: "", storage: memory() })).toEqual(DEFAULT_FEED_FLAGS);
  expect(DEFAULT_FEED_FLAGS).toEqual({ layout: "list", nav: "segments", undoSeconds: 5, captions: "shown" });
});

test("a build sets the defaults; unknown values leave a switch at its default", () => {
  expect(resolveFeedFlags({ env: { layout: "open-card", nav: "agents", undo: "4", captions: "hidden" }, hostname: "tinycloud.xyz", search: "", storage: null }))
    .toEqual({ layout: "open-card", nav: "agents", undoSeconds: 4, captions: "hidden" });
  expect(resolveFeedFlags({ env: { layout: "grid", nav: "tabs", undo: "3", captions: "off" }, hostname: "tinycloud.xyz", search: "", storage: null })).toEqual(DEFAULT_FEED_FLAGS);
});

test("only a preview deployment or a local server lets the address switch the feed", () => {
  for (const host of ["localhost", "127.0.0.1", PREVIEW, "skgbafa-tc-2600.tinychat.pages.dev"]) expect(previewHost(host)).toBe(true);
  for (const host of ["tinycloud.xyz", "home.tinycloud.xyz", "tinychat.pages.dev", "evil.example", "a.b.tinychat.pages.dev.evil.example"]) expect(previewHost(host)).toBe(false);
});

test("on the production site a link changes nothing, and nothing is saved", () => {
  const storage = memory({ [FEED_FLAGS_STORAGE_KEY]: JSON.stringify({ layout: "open-card" }) });
  for (const hostname of ["tinycloud.xyz", "tinychat.pages.dev"]) {
    expect(resolveFeedFlags({ env: {}, hostname, search: "?feed.layout=open-card&feed.undo=4", storage })).toEqual(DEFAULT_FEED_FLAGS);
  }
  expect(storage.values.get(FEED_FLAGS_STORAGE_KEY)).toBe(JSON.stringify({ layout: "open-card" }));
});

test("on a preview, a switch in the address is kept for the next load until ?feed=default", () => {
  const storage = memory();
  expect(resolveFeedFlags({ env: {}, hostname: PREVIEW, search: "?feed.layout=open-card&feed.undo=4", storage }))
    .toEqual({ ...DEFAULT_FEED_FLAGS, layout: "open-card", undoSeconds: 4 });
  // A sign-in redirect drops the query: the switches stay.
  expect(resolveFeedFlags({ env: {}, hostname: PREVIEW, search: "", storage })).toEqual({ ...DEFAULT_FEED_FLAGS, layout: "open-card", undoSeconds: 4 });
  // A later switch changes only itself.
  expect(resolveFeedFlags({ env: {}, hostname: PREVIEW, search: "?feed.nav=agents", storage })).toEqual({ ...DEFAULT_FEED_FLAGS, layout: "open-card", nav: "agents", undoSeconds: 4 });
  expect(resolveFeedFlags({ env: { captions: "hidden" }, hostname: PREVIEW, search: "?feed=default", storage })).toEqual({ ...DEFAULT_FEED_FLAGS, captions: "hidden" });
  expect(storage.values.has(FEED_FLAGS_STORAGE_KEY)).toBe(false);
  expect(resolveFeedFlags({ env: {}, hostname: PREVIEW, search: "", storage })).toEqual(DEFAULT_FEED_FLAGS);
});

test("the marker names only the switches away from their defaults", () => {
  expect(changedFlags(DEFAULT_FEED_FLAGS)).toEqual([]);
  expect(changedFlags({ layout: "open-card", nav: "agents", undoSeconds: 4, captions: "hidden" })).toEqual(["open card", "agents menu", "4 s undo", "no captions"]);
});
