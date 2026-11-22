import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { HELD_ANSWER_TTL_MS, holdAnswer, recordUnsentAnswer, type HeldAnswer, type UnsentAnswer } from "@/feed/answerOutbox";
import type { HomeFeedEntry } from "@/feed/feedStoreTypes";
import { savePostDraft } from "@/feed/postAnswers";
import { originMoveNoticeText } from "@/shell/OriginMoveNotice";
import { CANONICAL_ORIGIN, countLocalOnlyRecordingWork, decideOriginMove, NO_LOCAL_WORK, type LocalRecordingWork } from "./originMove";

// Account A's session expired on this device and kept its unsent answers; account B is signed in. The legacy-origin
// move counts B's answers as B's and never shows A's to B as B's own, but A's still keep the tab here.

const legacy = { hostname: "tinycloud.chat", pathname: "/chat", search: "", hash: "" };
const counted = (patch: Partial<LocalRecordingWork>): LocalRecordingWork => ({ ...NO_LOCAL_WORK, ...patch });
const SPACE_A = "tinycloud:pkh:eip155:1:0xaaaa:default";
const SPACE_B = "tinycloud:pkh:eip155:1:0xbbbb:default";

const store = new Map<string, string>();
const storage = {
  get length() { return store.size; },
  key: (index: number) => [...store.keys()][index] ?? null,
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
  clear: () => store.clear(),
} as Storage;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { localStorage: storage } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: storage });
});
afterEach(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as Record<string, unknown>).window;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete (globalThis as Record<string, unknown>).localStorage;
});

const held = (cardId: string): HeldAnswer => ({
  version: 2, sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}`, responseId: `response-${cardId}`, text: "Yes", at: new Date().toISOString(),
});
const unsent = (cardId: string): UnsentAnswer => ({
  sourceId: "agent-one", cardId, revision: 1, issuanceId: `issuance-${cardId}`, outcome: "refused", text: "No", at: new Date().toISOString(),
});
function post(spaceId: string, cardId: string): HomeFeedEntry {
  const identity = { cardId, revision: 1, issuanceId: "issuance-post" };
  return {
    source: { sourceId: "agent-one", agentDid: "did:key:post", label: "Agent", output: { spaceId, database: "out" }, responses: { spaceId, database: "in" } },
    state: { card: { ...identity, kind: "page", needsResponse: true, title: "A post", body: "Body", urgency: 1, createdAt: "2026-11-12T11:00:00.000Z" }, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", ...identity },
  };
}

function leaveAccountAWork() {
  holdAnswer(SPACE_A, held("a-held"));
  recordUnsentAnswer(SPACE_A, unsent("a-unsent"));
  savePostDraft(post(SPACE_A, "a-post"), { colour: { choices: ["Blue"], note: "" } });
}

describe("the legacy-origin move counts Home answers by the signed-in account", () => {
  test("with B signed in, A's answers are not B's counts, and they keep the tab here", async () => {
    leaveAccountAWork();
    const countAsB = () => countLocalOnlyRecordingWork({ factory: null, storage, space: SPACE_B });
    const work = await countAsB();
    expect(work).toEqual(counted({ otherAccountAnswers: 3 }));
    expect(await decideOriginMove({ location: legacy, countWork: countAsB, canonicalReady: async () => true }))
      .toEqual({ kind: "hold", work: counted({ otherAccountAnswers: 3 }) });

    const text = originMoveNoticeText(work);
    expect(text).not.toContain("still sending");
    expect(text).not.toContain("wasn't sent");
    expect(text).not.toContain("you haven't sent");
    expect(text).toContain("Another TinyCloud account has unsent answers in this browser. This tab moves once that account signs in here and sends them, or 7 days after they were written.");
  });

  test("B's own answers count as B's, apart from A's", async () => {
    leaveAccountAWork();
    holdAnswer(SPACE_B, held("b-held"));
    savePostDraft(post(SPACE_B, "b-post"), { colour: { choices: ["Green"], note: "" } });
    const work = await countLocalOnlyRecordingWork({ factory: null, storage, space: SPACE_B });
    expect(work).toEqual(counted({ heldAnswers: 1, postDrafts: 1, otherAccountAnswers: 3 }));
    expect(originMoveNoticeText(work)).toContain("1 answer is still sending from this tab.");
    expect(originMoveNoticeText(work)).toContain("1 post has answers you haven't sent.");
  });

  test("A, signed back in, sees its own answers as its own", async () => {
    leaveAccountAWork();
    expect(await countLocalOnlyRecordingWork({ factory: null, storage, space: SPACE_A }))
      .toEqual(counted({ heldAnswers: 1, unsentAnswers: 1, postDrafts: 1 }));
  });

  test("A's answers stop holding B's tab once they are older than the 7 days", async () => {
    leaveAccountAWork();
    const countAsB = () => countLocalOnlyRecordingWork({ factory: null, storage, space: SPACE_B });
    setSystemTime(new Date(Date.now() + HELD_ANSWER_TTL_MS + 1000));
    try {
      expect(await countAsB()).toEqual(NO_LOCAL_WORK);
      expect(await decideOriginMove({ location: legacy, countWork: countAsB, canonicalReady: async () => true }))
        .toEqual({ kind: "move", url: `${CANONICAL_ORIGIN}/chat` });
    } finally { setSystemTime(); }
  });
});
