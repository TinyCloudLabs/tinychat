import { describe, expect, test } from "bun:test";
import { oauthReturnTag } from "./connectors/googleOAuthState";
import {
  CANONICAL_ORIGIN, decideOriginMove, HOLD_COOKIE, HOME_ORIGIN, isLegacyOrigin, LEGACY_HOSTNAMES, NO_LOCAL_WORK, originMoveExemption,
  setHoldCookie, type LocalRecordingWork,
} from "./originMove";

const chat = { hostname: "tinycloud.chat", pathname: "/chat/feed", search: "?tab=all", hash: "#card-1" };
const home = { ...chat, hostname: "home.tinycloud.xyz" };
const counted = (patch: Partial<LocalRecordingWork>): LocalRecordingWork => ({ ...NO_LOCAL_WORK, ...patch });
const ready = async () => true;

function recorder() {
  const calls: boolean[] = [];
  return { calls, holdCookie: (hold: boolean) => { calls.push(hold); } };
}

describe("both legacy hosts move to tinycloud.one", () => {
  test("tinycloud.chat and home.tinycloud.xyz are legacy; tinycloud.one and lookalikes are not", () => {
    expect([...LEGACY_HOSTNAMES]).toEqual(["tinycloud.chat", "home.tinycloud.xyz"]);
    for (const hostname of LEGACY_HOSTNAMES) expect(isLegacyOrigin({ hostname })).toBe(true);
    for (const hostname of ["tinycloud.one", "www.tinycloud.one", "app.tinycloud.one", "xtinycloud.chat", "tinycloud.chat.evil.test"]) {
      expect(isLegacyOrigin({ hostname })).toBe(false);
    }
  });

  test("a clear visitor on either host moves to the same path, query and hash on tinycloud.one", async () => {
    for (const location of [chat, home]) {
      const { calls, holdCookie } = recorder();
      const decision = await decideOriginMove({ location, countWork: async () => NO_LOCAL_WORK, canonicalReady: ready, holdCookie });
      expect(decision).toEqual({ kind: "move", url: `${CANONICAL_ORIGIN}/chat/feed?tab=all#card-1` });
      expect(CANONICAL_ORIGIN).toBe("https://tinycloud.one");
      expect(calls).toEqual([false]);
    }
  });

  test("tinycloud.one itself never moves and touches nothing", async () => {
    const { calls, holdCookie } = recorder();
    expect(await decideOriginMove({ location: { ...chat, hostname: "tinycloud.one" }, countWork: async () => { throw new Error("must not count"); }, holdCookie })).toEqual({ kind: "stay" });
    expect(calls).toEqual([]);
  });

  test("Google returns keep their tags: home on home.tinycloud.xyz, one on tinycloud.one", () => {
    expect(HOME_ORIGIN).toBe("https://home.tinycloud.xyz");
    expect(oauthReturnTag(HOME_ORIGIN)).toBe("home");
    expect(oauthReturnTag(CANONICAL_ORIGIN)).toBe("one");
  });
});

describe("the hold cookie keeps the app loading for a visitor holding local-only work", () => {
  test("held work on either host sets it; nothing held clears it; an unreadable count counts as held", async () => {
    for (const location of [chat, home]) {
      for (const [label, work, expected] of [
        ["a recording is saving", counted({ saving: 1 }), true],
        ["an unsent answer", counted({ unsentAnswers: 1 }), true],
        ["a draft with an answer", counted({ postDrafts: 1 }), true],
        ["audio only here", counted({ localAudio: ["rec-1"] }), true],
        ["nothing local", NO_LOCAL_WORK, false],
      ] as const) {
        const { calls, holdCookie } = recorder();
        const decision = await decideOriginMove({ location, countWork: async () => work, canonicalReady: ready, holdCookie });
        expect({ label, cookie: calls, held: decision.kind === "hold" }).toEqual({ label, cookie: [expected], held: expected });
      }
      const failed = recorder();
      const decision = await decideOriginMove({ location, countWork: async () => { throw new Error("idb down"); }, canonicalReady: ready, holdCookie: failed.holdCookie });
      expect(decision.kind).toBe("hold");
      expect(failed.calls).toEqual([true]);
    }
  });

  test("the cookie is host-only, Secure, SameSite=Lax and lasts 400 days; clearing expires it", () => {
    const doc = { cookie: "" };
    setHoldCookie(true, doc);
    expect(doc.cookie).toBe(`${HOLD_COOKIE}=1; Path=/; Max-Age=34560000; Secure; SameSite=Lax`);
    expect(doc.cookie).not.toContain("Domain");
    setHoldCookie(false, doc);
    expect(doc.cookie).toBe(`${HOLD_COOKIE}=; Path=/; Max-Age=0; Secure; SameSite=Lax`);
    expect(HOLD_COOKIE).toBe("tc_hold");
  });

  test("a page without cookies, or one that refuses them, still decides", () => {
    expect(() => setHoldCookie(true, undefined)).not.toThrow();
    const refusing = { get cookie(): string { return ""; }, set cookie(_value: string) { throw new Error("blocked"); } };
    expect(() => setHoldCookie(true, refusing)).not.toThrow();
  });
});

describe("?legacy=1 is the way back to a legacy origin", () => {
  test("it is exempt only when legacy is exactly 1, on any path, and wins over nothing else", () => {
    expect(originMoveExemption({ pathname: "/chat/feed", search: "?legacy=1" }, false)).toBe("legacy");
    expect(originMoveExemption({ pathname: "/", search: "?x=1&legacy=1" }, false)).toBe("legacy");
    for (const search of ["", "?legacy=0", "?legacy=11", "?legacy=", "?legacyx=1", "?x=legacy=1"]) {
      expect(originMoveExemption({ pathname: "/chat", search }, false)).toBeNull();
    }
    expect(originMoveExemption({ pathname: "/chat", search: "?legacy=1" }, true)).toBe("popup");
  });

  test("on a legacy host it stays, never counts, and sets the cookie so plain visits keep loading the app", async () => {
    for (const hostname of LEGACY_HOSTNAMES) {
      const { calls, holdCookie } = recorder();
      const location = { hostname, pathname: "/chat", search: "?legacy=1", hash: "" };
      expect(await decideOriginMove({ location, countWork: async () => { throw new Error("must not count"); }, canonicalReady: ready, holdCookie })).toEqual({ kind: "stay" });
      expect(calls).toEqual([true]);
    }
  });

  test("the other exempt pages stay without touching the cookie", async () => {
    const { calls, holdCookie } = recorder();
    for (const location of [{ ...chat, pathname: "/agents/" }, { ...chat, search: "?code=x&state=tab.chat.abc&google_oauth_code=y" }]) {
      expect(await decideOriginMove({ location, countWork: async () => NO_LOCAL_WORK, canonicalReady: ready, holdCookie })).toEqual({ kind: "stay" });
    }
    expect(await decideOriginMove({ location: chat, opener: true, countWork: async () => NO_LOCAL_WORK, canonicalReady: ready, holdCookie })).toEqual({ kind: "stay" });
    expect(calls).toEqual([]);
  });
});
