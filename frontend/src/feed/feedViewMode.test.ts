import { afterEach, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { DEFAULT_FEED_VIEW_MODE, FEED_VIEW_MODE_KEY, FEED_VIEW_MODES, readFeedViewMode, saveFeedViewMode } from "./feedViewMode";

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });

test("with nothing saved the feed lists its cards as rows, as it always has", () => {
  restore = installDom();
  expect(readFeedViewMode()).toBe("compact");
  expect(DEFAULT_FEED_VIEW_MODE).toBe("compact");
});

test("each view is read back as saved", () => {
  restore = installDom();
  for (const mode of FEED_VIEW_MODES) {
    saveFeedViewMode(mode);
    expect(readFeedViewMode()).toBe(mode);
  }
});

test("a saved value that is not one of the views is ignored", () => {
  restore = installDom();
  window.localStorage.setItem(FEED_VIEW_MODE_KEY, "line");
  expect(readFeedViewMode()).toBe("compact");
});

test("storage that refuses to read or write leaves the default and does not throw", () => {
  const refusing = {
    getItem() { throw new Error("storage disabled"); },
    setItem() { throw new Error("storage disabled"); },
    removeItem() {}, clear() {}, key: () => null, length: 0,
  } as unknown as Storage;
  restore = installDom({ localStorage: refusing });
  expect(() => saveFeedViewMode("cards")).not.toThrow();
  expect(readFeedViewMode()).toBe("compact");
});
