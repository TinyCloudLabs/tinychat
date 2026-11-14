import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { HELD_ANSWER_TTL_MS, holdAnswer, recordUnsentAnswer, type HeldAnswer, type UnsentAnswer } from "@/feed/answerOutbox";
import type { HomeFeedEntry } from "@/feed/feedStoreTypes";
import { savePostDraft } from "@/feed/postAnswers";
import { countLocalOnlyRecordingWork, decideOriginMove, moveWhenClear, NO_LOCAL_WORK, type LocalRecordingWork } from "./originMove";
import { localStorageVoiceNotePendingStore } from "./voiceNotes/voiceNoteTranscription";

const legacy = { hostname: "tinycloud.chat", pathname: "/chat", search: "", hash: "" };
const counted = (patch: Partial<LocalRecordingWork>): LocalRecordingWork => ({ ...NO_LOCAL_WORK, ...patch });
const ready = async () => true;

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
  setSystemTime();
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else delete (globalThis as Record<string, unknown>).window;
  if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage); else delete (globalThis as Record<string, unknown>).localStorage;
});

const count = () => countLocalOnlyRecordingWork({ factory: null, storage });
const decide = () => decideOriginMove({ location: legacy, countWork: count, canonicalReady: ready });
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const held = (at = new Date().toISOString()): HeldAnswer => ({
  version: 2, sourceId: "agent-one", cardId: "card-one", revision: 1, issuanceId: "issuance-one", responseId: "response-one", text: "Yes", at,
});
const unsent = (at = new Date().toISOString()): UnsentAnswer => ({
  sourceId: "agent-one", cardId: "card-two", revision: 1, issuanceId: "issuance-two", outcome: "refused", text: "No", at,
});
function post(cardId = "post-one"): HomeFeedEntry {
  const identity = { cardId, revision: 1, issuanceId: "issuance-post" };
  return {
    source: { sourceId: "agent-one", agentDid: "did:key:post", label: "Agent", output: { spaceId: "space-one", database: "out" }, responses: { spaceId: "space-one", database: "in" } },
    state: { card: { ...identity, kind: "page", needsResponse: true, title: "A post", body: "Body", urgency: 1, createdAt: "2026-11-12T11:00:00.000Z" }, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", ...identity },
  };
}

describe("Home answers kept only in this origin's localStorage hold the move", () => {
  test("a fresh held answer holds", async () => {
    holdAnswer("space-one", held());
    expect(await decide()).toEqual({ kind: "hold", work: counted({ heldAnswers: 1 }) });
  });

  test("an unsent answer not yet seen holds", async () => {
    recordUnsentAnswer("space-one", unsent());
    expect(await decide()).toEqual({ kind: "hold", work: counted({ unsentAnswers: 1 }) });
  });

  test("a post draft with an answer holds; an empty one does not", async () => {
    savePostDraft(post("empty"), { colour: { choices: [], note: "  " } });
    expect(await decide()).toEqual({ kind: "move", url: "https://home.tinycloud.xyz/chat" });
    savePostDraft(post(), { colour: { choices: ["Blue"], note: "" } });
    expect(await decide()).toEqual({ kind: "hold", work: counted({ postDrafts: 1 }) });
  });

  test("entries older than the 7-day TTL, or malformed, hold nothing", async () => {
    holdAnswer("space-one", held(ago(HELD_ANSWER_TTL_MS + 1000)));
    recordUnsentAnswer("space-one", unsent(ago(HELD_ANSWER_TTL_MS + 1000)));
    setSystemTime(new Date(Date.now() - HELD_ANSWER_TTL_MS - 1000));
    savePostDraft(post(), { colour: { choices: ["Blue"], note: "" } });
    setSystemTime();
    store.set("tinychat.home.answer-outbox.v1:space-one:broken", "{not json");
    store.set("tinychat.home.answer-unsent.v1:space-one:broken", JSON.stringify({ outcome: "nope" }));
    store.set("tinychat.home.post-draft.v1:space-one:broken", JSON.stringify({ answers: { colour: { choices: ["Blue"], note: "" } } }));
    expect(await count()).toEqual(NO_LOCAL_WORK);
  });

  test("a fresh entry stops holding once it passes the TTL, even if nothing reads it", async () => {
    holdAnswer("space-one", held());
    expect((await count()).heldAnswers).toBe(1);
    setSystemTime(new Date(Date.now() + HELD_ANSWER_TTL_MS + 1000));
    expect(await decide()).toEqual({ kind: "move", url: "https://home.tinycloud.xyz/chat" });
  });

  test("recordings and answers are counted together", async () => {
    localStorageVoiceNotePendingStore("did:a", storage).write("running", { attemptId: "a1", transcriptionId: "t1" });
    holdAnswer("space-one", held());
    recordUnsentAnswer("space-one", unsent());
    savePostDraft(post(), { colour: { choices: [], note: "darker" } });
    expect(await decide()).toEqual({ kind: "hold", work: counted({ saving: 1, heldAnswers: 1, unsentAnswers: 1, postDrafts: 1 }) });
  });

  test("a held visitor keeps their answers; once only expired, empty or malformed ones are left, the move clears all three families before the replace", async () => {
    const win = new EventTarget();
    const replaced: { url: string; left: string[] }[] = [];
    let next = Promise.withResolvers<void>();
    const seen: LocalRecordingWork[] = [];
    store.set("unrelated", "kept");
    holdAnswer("space-one", held());
    const stop = moveWhenClear({
      location: { ...legacy, replace: (url: string) => { replaced.push({ url, left: [...store.keys()] }); next.resolve(); } },
      window: win, document: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
      opener: false, canonicalReady: ready, upload: () => null, onPending: (work) => { seen.push(work); next.resolve(); },
      countWork: () => countLocalOnlyRecordingWork({ factory: null, storage }),
    });
    await next.promise;
    expect(seen).toEqual([counted({ heldAnswers: 1 })]);
    expect(replaced).toEqual([]);
    expect(store.size).toBe(2);

    // The feed sent it; what is left of each family is expired, empty or malformed.
    store.delete([...store.keys()].find((key) => key.startsWith("tinychat.home.answer-outbox.v1:"))!);
    recordUnsentAnswer("space-one", unsent(ago(HELD_ANSWER_TTL_MS + 1000)));
    savePostDraft(post(), { colour: { choices: [], note: "" } });
    store.set("tinychat.home.answer-outbox.v1:space-one:broken", "{not json");
    next = Promise.withResolvers<void>();
    win.dispatchEvent(new Event("online"));
    await next.promise;
    expect(replaced).toEqual([{ url: "https://home.tinycloud.xyz/chat", left: ["unrelated"] }]);
    stop();
  });

  test("an answer held while the move decides keeps the page here, and the move goes once it is sent", async () => {
    const win = new EventTarget();
    const replaced: string[] = [];
    let next = Promise.withResolvers<void>();
    const seen: LocalRecordingWork[] = [];
    let writeDuringDecision = true;
    const stop = moveWhenClear({
      location: { ...legacy, replace: (url: string) => { replaced.push(url); next.resolve(); } },
      window: win, document: Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState }),
      opener: false, canonicalReady: ready, upload: () => null, onPending: (work) => { seen.push(work); next.resolve(); },
      // The count finds nothing; the feed holds an answer before the decision acts on it.
      countWork: async () => {
        const work = await countLocalOnlyRecordingWork({ factory: null, storage });
        if (writeDuringDecision) holdAnswer("space-one", held());
        writeDuringDecision = false;
        return work;
      },
    });
    await next.promise;
    expect(replaced).toEqual([]);
    expect(seen).toEqual([counted({ heldAnswers: 1 })]);
    expect([...store.keys()].filter((key) => key.startsWith("tinychat.home.answer-outbox.v1:"))).toHaveLength(1);

    // The feed sent it: the next check moves.
    store.delete([...store.keys()].find((key) => key.startsWith("tinychat.home.answer-outbox.v1:"))!);
    next = Promise.withResolvers<void>();
    win.dispatchEvent(new Event("online"));
    await next.promise;
    expect(replaced).toEqual(["https://home.tinycloud.xyz/chat"]);
    stop();
  });
});
