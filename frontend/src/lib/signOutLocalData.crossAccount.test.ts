import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  feedResourceNames, initializeFeedDatabases, listFeedResponses, publishFeedCard,
  type FeedCard, type FeedDatabase, type FeedSource,
} from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { heldAnswerKey, heldAnswers, type HeldAnswer } from "../feed/answerOutbox";
import { createHomeFeedSource, HOME_FEED_RESOURCE, SIGN_OUT_FLUSH_MS, settleHeldAnswersForSignOut } from "../feed/feedStore";
import type { HomeFeedEntry } from "../feed/feedStoreTypes";
import { postDraft, savePostDraft, type LabPage } from "../feed/postAnswers";
import { createUploadRunner, localStoragePendingUploadStore, type PendingUpload } from "./audioUpload";
import { __resetHomeWorkForTests } from "./homeReauthorizing";
import { setWebSignOutPending, webSignOutPendingKeepsUnsentWork, clearWebSignOutPending } from "./sessionSignOutFence";
import { clearSignedOutAccountStorage, clearSignedOutHeldResults, type SignOutScope } from "./signOutLocalData";
import { storedUploadFor } from "./uploadResume";
import { useLocalThreadStorage } from "./threadStore";
import { createHeldResultStore } from "./voiceNotes/heldResults";
import { localStorageVoiceNotePendingStore } from "./voiceNotes/voiceNoteTranscription";
import { newIdbEnv } from "./voiceNotes/web/testing/idb";
import type { IdbEnv } from "./voiceNotes/web/idb";

// Account A's session expires (the credentials-only sign-out), B signs in on the same device, then A signs in again.
// Each store A keeps must be invisible to B and never sent, retried or uploaded as B, and must be A's again after.
// The owner's own sign-out ("everything") still removes all of it.

const AGENT = "shared-agent"; // the same agent connected in both accounts: the closest a card can come to crossing
const CARD: FeedCard = {
  cardId: "plain-card", revision: 1, issuanceId: "plain-issuance-1", kind: "ask", needsResponse: true, title: "Book it?",
  body: "Two seats left.", urgency: 2, createdAt: "2026-11-21T10:00:00.000Z", choices: [{ id: "go", label: "Go" }, { id: "hold", label: "Hold" }],
};
const PAGE: LabPage = { image: "/look.png", imageAlt: "The look", questions: [{ id: "colour", question: "Which colour?", options: [{ label: "Blue" }, { label: "Green" }] }] };

let storage: Map<string, string>;
let restoreDom: () => void;
const databases: Database[] = [];
beforeEach(() => {
  storage = new Map();
  const localStorage = {
    get length() { return storage.size; },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
    clear: () => storage.clear(),
  } as Storage;
  restoreDom = installDom({ localStorage });
  __resetHomeWorkForTests();
});
afterEach(() => {
  restoreDom();
  for (const database of databases.splice(0)) database.close();
});

function feedHandle(database: Database, faults: { refuseWrites: boolean }, responses: boolean): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    execute,
    async query<T>(sql: string, params: (string | number | null | Uint8Array)[] = []) {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    async batch(statements) {
      // The expired session's writes fail in transport.
      if (responses && faults.refuseWrites) throw new Error("connection closed");
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const result = await execute(statement.sql, statement.params);
          if (!result.ok) throw new Error(result.error.message);
          results.push(result.data);
        }
        database.exec("COMMIT");
        return { ok: true, data: { results } };
      } catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

/** One account: its DID, address and space, its own Home databases over SQLite, and the shared agent's card in them. */
async function account(name: string, address: string) {
  const faults = { refuseWrites: false };
  const handles = new Map<string, FeedDatabase>();
  const db = (resource: string) => {
    let handle = handles.get(resource);
    if (!handle) {
      const sqlite = new Database(":memory:"); databases.push(sqlite);
      handle = feedHandle(sqlite, faults, resource.includes("/feed_responses_")); handles.set(resource, handle);
    }
    return handle;
  };
  const did = `did:pkh:eip155:1:${address}`;
  const spaceId = `space-${name}`;
  const tcw = useLocalThreadStorage({ did, spaceId, hooks: {}, sql: { db } } as unknown as TinyCloudWeb);
  await createHomeFeedSource(tcw).load();
  const names = feedResourceNames("xyz.tinycloud.tinychat/feed", AGENT);
  if (!names.ok) throw new Error("feed names");
  const output = db(names.data.outputResource);
  const responses = db(names.data.responseResource);
  if (!(await initializeFeedDatabases({ output, responses })).ok) throw new Error("feed init");
  const source: FeedSource = { sourceId: AGENT, agentDid: "did:key:synthetic-agent", label: "Agent", output: { spaceId, database: names.data.outputResource }, responses: { spaceId, database: names.data.responseResource } };
  await db(HOME_FEED_RESOURCE).execute(
    "INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)",
    [source.sourceId, source.agentDid, source.label, source.output.database, source.responses.database, "{}"],
  );
  if (!(await publishFeedCard(output, CARD)).ok) throw new Error("publish");
  const entry: HomeFeedEntry = {
    source, view: { sourceId: AGENT, cardId: CARD.cardId, revision: 1, issuanceId: CARD.issuanceId },
    state: { card: { ...CARD, kind: "page", payload: { page: PAGE } }, response: null, acknowledgement: null, outcome: null },
  };
  return {
    did, address, spaceId, tcw, faults, entry,
    async sent() { const listed = await listFeedResponses(responses); if (!listed.ok) throw new Error("list"); return listed.data; },
  };
}
type Account = Awaited<ReturnType<typeof account>>;

/** When A answered: inside the outbox's seven days. */
const ANSWERED_AT = new Date().toISOString();
const held = (owner: Account): HeldAnswer => ({
  sourceId: AGENT, cardId: CARD.cardId, revision: 1, issuanceId: CARD.issuanceId, responseId: `held-${owner.spaceId}`, choiceId: "go", at: ANSWERED_AT,
});
const upload = (owner: Account): PendingUpload => ({
  engine: "private-cloud", meetingId: `meeting-${owner.spaceId}`, attemptId: `attempt-${owner.spaceId}`, jobId: "remote-job",
  diarize: false, file: { name: "call.m4a", size: 1024, type: "audio/mp4", lastModified: 1_795_000_000_000 }, owner: owner.did, saved: false,
});
const transcript = (owner: Account) => ({
  version: 1 as const, did: owner.did, spaceId: owner.spaceId, sourceId: "note-1", engine: "private-cloud" as const,
  transcript: { rev: 1, sentences: [{ index: 0, text: "A's words", speaker_name: "Speaker 1", start_time: 0, end_time: 1 }], metadata: {}, speakers: [] },
  provider: null, intent: { kind: "unknown" as const },
});
/** The held-result store as the app opens it for whichever account is signed in. */
const heldStore = (owner: Account, env: IdbEnv, signedIn: () => string) =>
  createHeldResultStore(owner.did, { env, isSignedIn: async (did) => did === signedIn() });

/** Everything A has unsent on this device, plus A's credentials and caches. */
async function writeUnsentWork(a: Account, env: IdbEnv, signedIn: () => string) {
  window.localStorage.setItem(heldAnswerKey(a.spaceId, held(a)), JSON.stringify(held(a)));
  savePostDraft(a.entry, { colour: { choices: ["Green"], note: "A's note" } });
  localStoragePendingUploadStore(a.did).write(upload(a));
  localStorageVoiceNotePendingStore(a.did).write("note-1", { attemptId: "voice-attempt-a", transcriptionId: "ptx-a" });
  await heldStore(a, env, signedIn).hold(transcript(a));
  const lower = a.address.toLowerCase();
  for (const key of [`tinycloud:session:${lower}`, `tinycloud:session:runtime-grants:${lower}`, `tinychat:renewal-receipt:${lower}`, `tinychat:index:${a.did.toLowerCase()}`, `tinychat:memory:${a.did.toLowerCase()}`]) {
    window.localStorage.setItem(key, "secret-or-cache");
  }
  window.localStorage.setItem("tinycloud:session:active-address", lower);
}

/** What the app's sign-out does to this device's storage for `scope`. */
async function signOut(scope: SignOutScope, a: Account, env: IdbEnv) {
  clearSignedOutAccountStorage(scope, { space: a.spaceId, did: a.did, address: a.address });
  await clearSignedOutHeldResults(scope, a.did, env);
}

const credentialKeys = (a: Account) => {
  const lower = a.address.toLowerCase();
  return [`tinycloud:session:${lower}`, `tinycloud:session:runtime-grants:${lower}`, `tinychat:renewal-receipt:${lower}`, "tinycloud:session:active-address", `tinychat:index:${a.did.toLowerCase()}`, `tinychat:memory:${a.did.toLowerCase()}`];
};

test("A's session expires and B signs in: B sees and sends none of A's unsent work; A signs back in and has all of it", async () => {
  const env = newIdbEnv();
  const a = await account("a", "0xAaAaaAAaaAaAaaaaAAAAaaaaaaaAaaaaaAaaAaA1");
  const b = await account("b", "0xbBBbBbbbBBbbbbBbbbbBbbbBbbbBbBbbBBbBbBb2");
  let signedIn = a.did;
  await writeUnsentWork(a, env, () => signedIn);

  // A's session expires. Its one bounded try to send held answers fails (the transport refuses), so the answer stays.
  a.faults.refuseWrites = true;
  await settleHeldAnswersForSignOut(a.tcw, SIGN_OUT_FLUSH_MS, { keepUnsent: true });
  await signOut("credentials", a, env);
  signedIn = "";
  // Credentials and caches are gone.
  for (const key of credentialKeys(a)) expect(window.localStorage.getItem(key)).toBeNull();

  // B signs in on the same device.
  signedIn = b.did;
  // Reads: nothing of A's under B's space or DID.
  expect(heldAnswers(b.spaceId)).toEqual([]);
  expect(postDraft(b.entry, PAGE)).toBeUndefined();
  expect(storedUploadFor({ did: b.did })).toBeNull();
  expect(localStorageVoiceNotePendingStore(b.did).sourceIds()).toEqual([]);
  expect(localStorageVoiceNotePendingStore(b.did).read("note-1")).toBeNull();
  expect(await heldStore(b, env, () => signedIn).listHeld()).toEqual([]);
  // Sends, retries and uploads as B. B's launch flushes B's held answers, and B has the same agent and card.
  const bLaunch = createHomeFeedSource(b.tcw);
  await bLaunch.load();
  expect(await bLaunch.flushHeldAnswers!()).toEqual([]);
  expect(await b.sent()).toEqual([]);
  // B's sign-out try sends nothing either: with nothing held under B's space it makes no request at all.
  await settleHeldAnswersForSignOut(b.tcw, SIGN_OUT_FLUSH_MS, { keepUnsent: true });
  expect(await b.sent()).toEqual([]);
  // B's held-transcript commit finds nothing to save.
  let savedAsB = 0;
  expect(await heldStore(b, env, () => signedIn).saveHeldFirst(b.tcw, "note-1", {
    save: async () => { savedAsB++; }, afterCommit: async () => {},
  }, "automatic")).toBe("discarded_superseded");
  expect(savedAsB).toBe(0);
  // B's upload resume finds no job of its own and touches the network for none.
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response(null, { status: 500 }); }) as unknown as typeof fetch;
  try {
    const runner = createUploadRunner();
    runner.resume({ tcw: b.tcw, privateCloud: null, save: (async () => { throw new Error("must not save as B"); }) as never });
    expect(runner.snapshot()).toBeNull();
    expect(requests).toBe(0);
  } finally { globalThis.fetch = previousFetch; }
  // And A's answer was never written to A's space by any of it.
  expect(await a.sent()).toEqual([]);

  // A signs back in: everything A left is A's again, and A's launch sends the held answer as A.
  signedIn = a.did;
  a.faults.refuseWrites = false;
  expect(heldAnswers(a.spaceId)).toEqual([held(a)]);
  expect(postDraft(a.entry, PAGE)).toEqual({ colour: { choices: ["Green"], note: "A's note" } });
  expect(storedUploadFor({ did: a.did })).toEqual(upload(a));
  expect(localStorageVoiceNotePendingStore(a.did).read("note-1")).toMatchObject({ attemptId: "voice-attempt-a", transcriptionId: "ptx-a" });
  expect((await heldStore(a, env, () => signedIn).listHeld()).map((row) => row.sourceId)).toEqual(["note-1"]);
  const aLaunch = createHomeFeedSource(a.tcw);
  await aLaunch.load();
  expect(await aLaunch.flushHeldAnswers!()).toEqual([{ sourceId: AGENT, cardId: CARD.cardId, outcome: "sent" }]);
  expect((await a.sent()).map((row) => [row.responseId, row.choiceId])).toEqual([[held(a).responseId, "go"]]);
  expect(heldAnswers(a.spaceId)).toEqual([]);
  expect(await b.sent()).toEqual([]);
});

test("the owner's own sign-out still removes every store, credentials and caches included", async () => {
  const env = newIdbEnv();
  const a = await account("a", "0xAaAaaAAaaAaAaaaaAAAAaaaaaaaAaaaaaAaaAaA1");
  let signedIn = a.did;
  await writeUnsentWork(a, env, () => signedIn);
  await signOut("everything", a, env);
  signedIn = "";
  for (const key of credentialKeys(a)) expect(window.localStorage.getItem(key)).toBeNull();
  signedIn = a.did;
  expect(heldAnswers(a.spaceId)).toEqual([]);
  expect(postDraft(a.entry, PAGE)).toBeUndefined();
  expect(storedUploadFor({ did: a.did })).toBeNull();
  expect(localStorageVoiceNotePendingStore(a.did).sourceIds()).toEqual([]);
  expect(await heldStore(a, env, () => signedIn).listHeld()).toEqual([]);
});

test("a restart that finishes an expired session's sign-out keeps the unsent work; an owner's sign-out after it does not", () => {
  const token = setWebSignOutPending("0xA1", true);
  expect(token).not.toBeNull();
  expect(webSignOutPendingKeepsUnsentWork()).toBe(true);
  // The owner signs out while that one is pending: the newer fence clears everything.
  const owner = setWebSignOutPending("0xA1");
  expect(webSignOutPendingKeepsUnsentWork()).toBe(false);
  expect(clearWebSignOutPending("0xA1", owner!)).toBe(true);
  expect(webSignOutPendingKeepsUnsentWork()).toBe(false);
});
