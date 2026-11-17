// TC-3195: a share link's fragment holds the key to its sealed record. It is read into memory and removed from the
// address bar at startup, before the app renders, so it never stays in history or reaches a Referer or a log.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";

import { captureShareLinkFromLocation, heldShareLink, holdShareLinkUrl, isShareLinkPath, releaseShareLink } from "./link";

const FRAGMENT = "#v=4&k=QmFzZTY0VXJsQ29udGVudEtleQ&c=bafyroot";

function fakePage(href: string) {
  const url = new URL(href);
  const location = { href: url.href, pathname: url.pathname, search: url.search, hash: url.hash } as Location;
  const calls: { state: unknown; url: string | URL | null | undefined }[] = [];
  const history = {
    state: { idx: 0 },
    replaceState(state: unknown, _unused: string, next?: string | URL | null) {
      calls.push({ state, url: next });
    },
  } as unknown as History;
  const doc = new Window({ url: url.href }).document as unknown as Document;
  return { location, history, calls, doc };
}

afterEach(() => releaseShareLink());

describe("captureShareLinkFromLocation", () => {
  test("keeps the whole link in memory and replaces the address without its fragment", () => {
    const href = `https://tinycloud.one/s/7f3kq9x2m4hz8a1c5vd0wnbe6y?utm=x${FRAGMENT}`;
    const page = fakePage(href);
    expect(captureShareLinkFromLocation(page.location, page.history, page.doc)).toBe(true);
    expect(page.calls).toEqual([{ state: { idx: 0 }, url: "/s/7f3kq9x2m4hz8a1c5vd0wnbe6y?utm=x" }]);
    expect(String(page.calls[0]!.url)).not.toContain("#");
    expect(String(page.calls[0]!.url)).not.toContain("k=");
    expect(heldShareLink()).toBe(href);
    expect(page.doc.querySelector('meta[name="referrer"]')?.getAttribute("content")).toBe("no-referrer");
    releaseShareLink();
    expect(heldShareLink()).toBeNull();
  });

  test("leaves other pages alone", () => {
    const page = fakePage(`https://tinycloud.one/chat${FRAGMENT}`);
    expect(captureShareLinkFromLocation(page.location, page.history, page.doc)).toBe(false);
    expect(page.calls).toEqual([]);
    expect(heldShareLink()).toBeNull();
    expect(page.doc.querySelector('meta[name="referrer"]')).toBeNull();
  });

  test("a share page without a fragment is still a share page, with nothing to hold", () => {
    const page = fakePage("https://tinycloud.one/s/7f3kq9x2m4hz8a1c5vd0wnbe6y");
    expect(captureShareLinkFromLocation(page.location, page.history, page.doc)).toBe(true);
    expect(page.calls).toEqual([]);
    expect(heldShareLink()).toBeNull();
  });

  test("only /s/<id> is a share path", () => {
    expect(isShareLinkPath("/s/abc_DEF-123")).toBe(true);
    expect(isShareLinkPath("/s/abc/")).toBe(true);
    for (const path of ["/s/", "/s/abc/def", "/share/abc", "/s/abc.def", `/s/${"a".repeat(65)}`]) expect(isShareLinkPath(path)).toBe(false);
  });

  test("main.tsx runs it before anything renders", () => {
    const main = readFileSync(join(import.meta.dir, "../../main.tsx"), "utf8");
    const capture = main.indexOf("\ncaptureShareLinkFromLocation();");
    expect(capture).toBeGreaterThan(0);
    expect(capture).toBeLessThan(main.indexOf("createRoot(document"));
    expect(capture).toBeLessThan(main.indexOf("installDebugLog("));
  });
});

describe("holdShareLinkUrl (the phone app opened with a link)", () => {
  test("holds a share link on the share origin and returns its in-app path, without the fragment", () => {
    const url = `https://tinycloud.one/s/7f3kq9x2m4hz8a1c5vd0wnbe6y${FRAGMENT}`;
    expect(holdShareLinkUrl(url)).toBe("/s/7f3kq9x2m4hz8a1c5vd0wnbe6y");
    expect(heldShareLink()).toBe(url);
  });

  test("ignores other origins, other paths and OAuth returns", () => {
    for (const url of [`https://evil.example/s/abc${FRAGMENT}`, `https://tinycloud.one/chat${FRAGMENT}`, "xyz.tinycloud.exo://oauth/google?code=1", "not a url"]) {
      expect(holdShareLinkUrl(url)).toBeNull();
    }
    expect(heldShareLink()).toBeNull();
  });
});
