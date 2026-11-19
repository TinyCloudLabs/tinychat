import { expect, test } from "bun:test";
import { decideOriginMove, deferOriginMove, NO_LOCAL_WORK } from "./originMove";

// The edge sends a plain visit to a legacy host on to tinycloud.one before the app loads, unless the `tc_hold` cookie
// is set. A page that closes while work lives only in its memory (an Undo-bar action counting, a send in its undo
// window) writes an entry into this origin's outbox on the way out; the cookie must still be set then, or that entry
// is never loaded and never sent.

const legacy = { hostname: "tinycloud.chat", pathname: "/chat", search: "", hash: "" };
const check = (cookies: boolean[]) => decideOriginMove({ location: legacy, opener: false, countWork: async () => NO_LOCAL_WORK, canonicalReady: async () => true, holdCookie: (hold) => { cookies.push(hold); } });

test("a check that runs while work lives only in the page leaves the hold cookie set, and one that finds nothing held clears it", async () => {
  const cookies: boolean[] = [];
  const release = deferOriginMove({ location: { hostname: "example.test" } });
  expect((await check(cookies)).kind).toBe("move");
  expect(cookies).toEqual([true]);
  release();
  await check(cookies);
  expect(cookies).toEqual([true, false]);
});

test("work that starts between two checks sets the hold cookie at once on a legacy origin, so a close inside that gap is covered", async () => {
  const cookies: boolean[] = [];
  // The last check found nothing held and cleared the cookie.
  await check(cookies);
  expect(cookies).toEqual([false]);
  // A send starts its undo window; the page closes before the next check.
  const release = deferOriginMove({ location: legacy, holdCookie: (hold) => { cookies.push(hold); } });
  expect(cookies).toEqual([false, true]);
  release();
});

test("work that starts on another origin sets no hold cookie", () => {
  const cookies: boolean[] = [];
  for (const hostname of ["tinycloud.one", "localhost"]) deferOriginMove({ location: { hostname }, holdCookie: (hold) => { cookies.push(hold); } })();
  expect(cookies).toEqual([]);
});
