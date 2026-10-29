import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { appendFeedMessage, appendFeedResponse, feedResourceNames, initializeFeedDatabases, publishFeedCard, recordFeedHandling, type FeedCard, type FeedDatabase, type FeedHooks } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import type { HomeFeedEntry, HomeFeedSnapshot } from "./feedStoreTypes";
import { useLocalThreadStorage } from "../lib/threadStore";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { syntheticRecord, SITREP_NOW } from "./sitrep.fixtures";
import { compactStamp, NOTE_HISTORY_MAX, projectSitrepCard, parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";

const databases: Database[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const database of databases.splice(0)) database.close();
});

function sqliteHandle(database: Database): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    query: async <T>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      const statement = database.query(sql);
      // The SDK's generic query contract uses positional rows, as does SQLite.
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
    execute,
    async batch(statements) {
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

function registryClient(hooks?: FeedHooks) {
  const handles = new Map<string, FeedDatabase>();
  function handle(resource: string) {
    let existing = handles.get(resource);
    if (!existing) {
      const database = new Database(":memory:");
      databases.push(database);
      existing = sqliteHandle(database);
      handles.set(resource, existing);
    }
    return existing;
  }
  const database = new Database(":memory:");
  databases.push(database);
  handles.set(HOME_FEED_RESOURCE, sqliteHandle(database));
  const client = {
    spaceId: "isolated-feed-registry-test", hooks: hooks ?? {},
    sql: { db: handle },
  };
  // Only browser SDK transport is substituted; SQL and canonical projections
  // execute for real. Existing local thread settings isolate unrelated storage.
  const tcw = useLocalThreadStorage(client as unknown as TinyCloudWeb);
  return { database, handle, source: createHomeFeedSource(tcw), replaceHooks(next: FeedHooks) { client.hooks = next; }, replaceSpace(next: string) { client.spaceId = next; } };
}

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message);
  return result.data as T;
}

async function agentFixture(hooks?: FeedHooks) {
  const fixture = registryClient(hooks);
  await fixture.source.load();
  const resources = value(feedResourceNames("xyz.tinycloud.tinychat/feed", "isolatedtest"));
  const output = fixture.handle(resources.outputResource);
  const responses = fixture.handle(resources.responseResource);
  value(await initializeFeedDatabases({ output, responses }));
  fixture.database.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)")
    .run("isolated-agent", "did:key:isolated-test-agent", "Test agent", resources.outputResource, resources.responseResource, "{}");
  const card: FeedCard = { cardId: "isolated-card", revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title: "Original question", body: "Original body", urgency: 1, createdAt: "2026-10-29T00:00:00Z" };
  value(await publishFeedCard(output, card));
  return { ...fixture, output, responses, card };
}

test("a malformed persisted owner event is rejected instead of silently changing attention", async () => {
  const { database, source } = registryClient();
  // An owner SQL writer can create this supported schema without a CHECK.
  // Do not let a malformed kind pass as seen, snoozed, or a future answer kind.
  database.exec(`CREATE TABLE feed_view_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
    card_id TEXT NOT NULL, revision INTEGER NOT NULL, issuance_id TEXT NOT NULL,
    kind TEXT NOT NULL, created_at TEXT NOT NULL, snoozed_until TEXT
  )`);
  database.query("INSERT INTO feed_view_events (agent_id,card_id,revision,issuance_id,kind,created_at,snoozed_until) VALUES (?,?,?,?,?,?,?)")
    .run("isolated-agent", "decision", 1, "issuance-1", "snoozed ", "2026-10-29T00:00:00Z", "2099-01-01T00:00:00Z");
  await expect(source.load()).rejects.toThrow("Invalid Home feed view event");
});

test("a retained old issuance loads its real saved response and outcome after the latest list replaces it", async () => {
  const fixture = await agentFixture();
  const initial = await fixture.source.load();
  const retained = initial.entries[0]!;
  const response = value(await appendFeedResponse(fixture.output, fixture.responses, {
    cardId: fixture.card.cardId, revision: 1, issuanceId: "issuance-1", responseId: "retained-response",
    kind: "answer", text: "Answer for the original issuance", createdAt: "2026-10-29T00:01:00Z",
  }));
  value(await recordFeedHandling(fixture.output, {
    cardId: fixture.card.cardId, revision: 1, issuanceId: "issuance-1", responseId: response.responseId,
    handlingId: "retained-outcome", phase: "succeeded", createdAt: "2026-10-29T00:02:00Z",
    detail: { message: "Original issuance action completed" },
  }));
  value(await publishFeedCard(fixture.output, { ...fixture.card, revision: 2, issuanceId: "issuance-2", title: "Replacement question" }));
  // The optional focused argument is the UI's persistence boundary, not a
  // copied card list. Existing load() ignores it and loses this exact issuance.
  const loadFocused: (entry?: HomeFeedEntry) => Promise<HomeFeedSnapshot & { focusedEntry?: HomeFeedEntry }> = fixture.source.load;
  const refreshed = await loadFocused(retained);
  expect(refreshed.entries.map((entry) => entry.state.card.revision)).toEqual([2]);
  expect(refreshed.focusedEntry?.state.card).toMatchObject({ revision: 1, issuanceId: "issuance-1", title: "Original question" });
  expect(refreshed.focusedEntry?.state.response).toMatchObject({ responseId: response.responseId, text: "Answer for the original issuance" });
  expect(refreshed.focusedEntry?.state.outcome).toMatchObject({ phase: "succeeded", detail: { message: "Original issuance action completed" } });
});

test("replacing the native hook service restores consumer notifications from the new graph", async () => {
  cleanups.push(installDom());
  jest.useFakeTimers();
  // Route happy-dom's browser timers through Bun's deterministic fake clock.
  const timeout = spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
    if (typeof callback !== "function") throw new Error("Unexpected string timer");
    return Number(globalThis.setTimeout(() => callback(...args), delay));
  });
  const interval = spyOn(window, "setInterval").mockImplementation((callback, delay, ...args) => {
    if (typeof callback !== "function") throw new Error("Unexpected string timer");
    return Number(globalThis.setInterval(() => callback(...args), delay));
  });
  const clearTimeoutSpy = spyOn(window, "clearTimeout").mockImplementation((id) => globalThis.clearTimeout(id));
  const clearIntervalSpy = spyOn(window, "clearInterval").mockImplementation((id) => globalThis.clearInterval(id));
  cleanups.push(() => { timeout.mockRestore(); interval.mockRestore(); clearTimeoutSpy.mockRestore(); clearIntervalSpy.mockRestore(); jest.useRealTimers(); });
  const stopped = (signal?: AbortSignal) => new Promise<null>((resolve) => {
    if (signal?.aborted) resolve(null);
    else signal?.addEventListener("abort", () => resolve(null), { once: true });
  });
  const oldEnded = Promise.withResolvers<void>();
  const oldHooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      options?.onReady?.();
      await Promise.race([oldEnded.promise, stopped(options?.signal)]);
    },
  };
  const fixture = await agentFixture(oldHooks);
  await fixture.source.load();
  const observed: HomeFeedSnapshot[] = [];
  const errors: unknown[] = [];
  const unsubscribe = fixture.source.subscribe(() => {
    void fixture.source.load().then((snapshot) => observed.push(snapshot), (error) => errors.push(error));
  });
  cleanups.push(unsubscribe);
  async function changed() {
    for (let step = 0; step < 64; step++) await Promise.resolve();
    jest.advanceTimersByTime(50);
    for (let step = 0; step < 64; step++) await Promise.resolve();
    expect(errors).toEqual([]);
    return observed.at(-1);
  }
  expect((await changed())?.entries[0]?.state.card.revision).toBe(1);
  oldEnded.resolve();
  await changed();
  const event = { type: "write" as const, id: "replacement-write", space: "isolated-feed-registry-test", service: "sql", ability: "tinycloud.sql/write", path: "xyz.tinycloud.tinychat/feed/feed_output_isolatedtest", actor: "did:key:isolated-test-agent", epoch: "test", eventIndex: 1, timestamp: "2026-10-29T00:03:00Z" };
  const incoming = Promise.withResolvers<typeof event>();
  const newHooks: FeedHooks = {
    async *subscribe(_subscriptions, options) {
      options?.onReady?.();
      const notification = await Promise.race([incoming.promise, stopped(options?.signal)]);
      if (notification) yield notification;
      await stopped(options?.signal);
    },
  };
  fixture.replaceHooks(newHooks);
  await fixture.source.load();
  value(await publishFeedCard(fixture.output, { ...fixture.card, revision: 2, issuanceId: "issuance-2", title: "Published after native session restore" }));
  incoming.resolve(event);
  const refreshed = await changed();
  expect(refreshed?.entries[0]?.state.card).toMatchObject({ revision: 2, title: "Published after native session restore" });
  expect(refreshed?.connectionError).toBeUndefined();
});

test("new Home private notes persist in owner SQLite only and remain isolated from a replacement issuance", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("task");
  if (typeof record.id !== "string") throw new Error("Invalid synthetic task identity");
  const typedCard = { ...fixture.card, revision: 2, issuanceId: "private-issuance", kind: "task", payload: { sitrep: { version: 1, record } } };
  value(await publishFeedCard(fixture.output, typedCard));
  const entry = (await fixture.source.load()).entries[0]!;
  const event = { eventId: "private-owner-note", state: { kind: "task" as const, id: record.id, steps: {}, notes: [{ id: "private000000001", at: SITREP_NOW, text: "Private Home note, not a legacy send-note" }], updatedAt: SITREP_NOW } };
  if (!fixture.source.saveOwnerState) throw new Error("Real source lacks owner persistence");
  await fixture.source.saveOwnerState(entry, event);
  await fixture.source.saveOwnerState(entry, event);
  const loaded = await fixture.source.load();
  expect(loaded.entries[0]!.owner?.states[0]?.notes?.map((note) => note.text)).toEqual(["Private Home note, not a legacy send-note"]);
  expect(fixture.database.query("SELECT COUNT(*) FROM feed_owner_events").get()).toEqual({ "COUNT(*)": 1 });
  expect(value(await fixture.responses.query("SELECT response_id FROM feed_responses")).rows).toEqual([]);
  await expect(fixture.source.saveOwnerState(entry, { ...event, state: { ...event.state, notes: [{ ...event.state.notes[0]!, text: "Changed immutable private event" }] } })).rejects.toThrow("different content");
  value(await publishFeedCard(fixture.output, { ...typedCard, revision: 3, issuanceId: "replacement-private-issuance" }));
  expect((await fixture.source.load()).entries[0]!.owner?.states.flatMap((state) => state.notes ?? []) ?? []).toEqual([]);
});

test("a stored message carrying answer-shaped data cannot clear a typed question", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("ask");
  const card = { ...fixture.card, revision: 2, issuanceId: "message-is-not-answer", payload: { sitrep: { version: 1, record } } };
  value(await publishFeedCard(fixture.output, card));
  value(await appendFeedMessage(fixture.output, fixture.responses, { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, responseId: "not-an-answer", kind: "message", text: "Context only", createdAt: SITREP_NOW }, { type: "sitrep.answer", version: 1, data: { askId: "ask-synthetic", action: "answer", text: "An incompatible message must not decide this", at: SITREP_NOW } }));
  const entry = (await fixture.source.load()).entries[0]!;
  const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
  if (!typed || !entry.owner) throw new Error("Typed owner history was not loaded");
  expect(projectSitrepCard(typed.record, [typed.record], entry.owner, Date.parse(SITREP_NOW)).needsAction).toBe(true);
  expect(entry.owner.unsupportedResponses).toContainEqual({ responseId: "not-an-answer", reason: "Message payload cannot answer a card" });
  expect(entry.state.response).toBeNull();
});

test("a retired account source refuses reads and writes instead of using a replacement session", async () => {
  const fixture = await agentFixture();
  const entry = (await fixture.source.load()).entries[0]!;
  fixture.replaceSpace("different-owner-space");
  await expect(fixture.source.load()).rejects.toThrow("account");
  await expect(fixture.source.saveResponse(entry, { cardId: entry.state.card.cardId, revision: entry.state.card.revision, issuanceId: entry.state.card.issuanceId, responseId: "retired-owner-response", kind: "answer", text: "Must not cross accounts", createdAt: SITREP_NOW })).rejects.toThrow("account");
  expect(value(await fixture.responses.query("SELECT response_id FROM feed_responses")).rows).toEqual([]);
});

test("private owner decisions follow durable commit order despite a backwards clock", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("task");
  if (typeof record.id !== "string") throw new Error("Invalid synthetic task identity");
  value(await publishFeedCard(fixture.output, { ...fixture.card, revision: 2, issuanceId: "private-order", kind: "task", payload: { sitrep: { version: 1, record } } }));
  const entry = (await fixture.source.load()).entries[0]!;
  if (!fixture.source.saveOwnerState) throw new Error("Real source lacks owner persistence");
  await fixture.source.saveOwnerState(entry, { eventId: "pin-later-clock", state: { kind: "task", id: record.id, steps: {}, priority: { on: true, at: SITREP_NOW }, updatedAt: SITREP_NOW } });
  await fixture.source.saveOwnerState(entry, { eventId: "unpin-after-clock-rollback", state: { kind: "task", id: record.id, steps: {}, priority: { on: false, at: "2026-10-29T00:00:00.000Z" }, updatedAt: "2026-10-29T00:00:00.000Z" } });
  expect((await fixture.source.load()).entries[0]?.owner?.states[0]?.priority?.on).toBe(false);
});

test("group priority persists privately without rewriting another group's decision or sending an answer", async () => {
  const fixture = await agentFixture();
  const record = { ...syntheticRecord("ask"), group: "Synthetic rollout" };
  const other = { ...syntheticRecord("ask"), id: "other-group", group: "Other rollout" };
  value(await publishFeedCard(fixture.output, { ...fixture.card, revision: 2, issuanceId: "group-first", payload: { sitrep: { version: 1, record } } }));
  value(await publishFeedCard(fixture.output, { ...fixture.card, cardId: "other-group-card", payload: { sitrep: { version: 1, record: other } } }));
  const initial = await fixture.source.load();
  const first = initial.entries.find((entry) => entry.state.card.cardId === fixture.card.cardId)!;
  const second = initial.entries.find((entry) => entry.state.card.cardId === "other-group-card")!;
  if (!fixture.source.setGroupPriority) throw new Error("Real source lacks private group persistence");
  await fixture.source.setGroupPriority(first, "Synthetic rollout", true);
  await fixture.source.setGroupPriority(second, "Other rollout", true);
  await fixture.source.setGroupPriority(first, "Synthetic rollout", false);
  const groups = (await fixture.source.load()).sitrep?.groupPriority?.groups;
  expect(groups?.["Synthetic rollout"]?.on).toBe(false);
  expect(groups?.["Other rollout"]?.on).toBe(true);
  expect(value(await fixture.responses.query("SELECT response_id FROM feed_responses")).rows).toEqual([]);
  await expect(fixture.source.setGroupPriority(first, "Not this card's group", true)).rejects.toThrow("group");
});

test("concurrent private notes cannot overfill owner history or discard previously saved notes", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("task");
  if (typeof record.id !== "string") throw new Error("Invalid synthetic task identity");
  const recordId = record.id;
  value(await publishFeedCard(fixture.output, { ...fixture.card, revision: 2, issuanceId: "private-note-boundary", kind: "task", payload: { sitrep: { version: 1, record } } }));
  const entry = (await fixture.source.load()).entries[0]!;
  const write = fixture.source.saveOwnerState;
  if (!write) throw new Error("Real source lacks owner persistence");
  const original = Array.from({ length: NOTE_HISTORY_MAX - 1 }, (_, index) => ({ id: `n${String(index).padStart(8, "0")}`, at: SITREP_NOW, text: `Private original note ${index}` }));
  await write(entry, { eventId: "notes-before-race", state: { kind: "task", id: record.id, steps: {}, notes: original, updatedAt: SITREP_NOW } });
  const candidates = ["Private concurrent note left", "Private concurrent note right"];
  const results = await Promise.allSettled(candidates.map((text, index) => write(entry, { eventId: `concurrent-note-${index}`, state: { kind: "task", id: recordId, steps: {}, notes: [{ id: `concurrent${index}`, at: SITREP_NOW, text }], updatedAt: SITREP_NOW } })));
  expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
  expect(results.filter((result) => result.status === "rejected").length).toBe(1);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  const notes = (await fixture.source.load()).entries[0]?.owner?.states[0]?.notes?.map((note) => note.text);
  expect(new Set(notes)).toEqual(new Set([...original.map((note) => note.text), candidates[winner]!]));
  expect(value(await fixture.responses.query("SELECT response_id FROM feed_responses")).rows).toEqual([]);
});

test("conflicting immutable officer messages stay visible as unsupported output instead of replacing a thread or breaking Home", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("ask");
  if (typeof record.id !== "string") throw new Error("Invalid synthetic ask identity");
  const parent = { ...fixture.card, revision: 2, issuanceId: "officer-thread-parent", payload: { sitrep: { version: 1, record } } };
  value(await publishFeedCard(fixture.output, parent));
  const message = { side: "officer", kind: "ask", id: record.id, messageId: `${compactStamp(SITREP_NOW)}-00000000000000000000000000000001`, at: SITREP_NOW, from: "SyntheticOfficer", text: "Original immutable officer message" };
  const identity = { cardId: parent.cardId, revision: parent.revision, issuanceId: parent.issuanceId };
  for (const [cardId, text] of [["reply-one", message.text], ["reply-two", "Conflicting officer message body"]] as const) {
    value(await publishFeedCard(fixture.output, { ...fixture.card, cardId, kind: "thread", needsResponse: false, payload: { sitrepThread: { version: 1, parent: identity, message: { ...message, text } } } }));
  }
  const snapshot = await fixture.source.load();
  expect(snapshot.entries.map((entry) => entry.state.card.cardId).sort()).toEqual([parent.cardId, "reply-one", "reply-two"].sort());
  expect(snapshot.entries.find((entry) => entry.state.card.cardId === parent.cardId)?.owner?.threads).toEqual([]);
});

test("a fresh Home recovers an officer thread from an older output issuance after its enclosing card is replaced", async () => {
  const fixture = await agentFixture();
  const record = syntheticRecord("ask");
  if (typeof record.id !== "string") throw new Error("Invalid synthetic ask identity");
  const parent = { ...fixture.card, revision: 2, issuanceId: "historical-officer-parent", payload: { sitrep: { version: 1, record } } };
  value(await publishFeedCard(fixture.output, parent));
  const message = { side: "officer", kind: "ask", id: record.id, messageId: `${compactStamp(SITREP_NOW)}-00000000000000000000000000000002`, at: SITREP_NOW, from: "SyntheticOfficer", text: "The complete immutable earlier officer reply." };
  const envelope = { ...fixture.card, cardId: "reissued-thread-container", kind: "thread", needsResponse: false, payload: { sitrepThread: { version: 1, parent: { cardId: parent.cardId, revision: parent.revision, issuanceId: parent.issuanceId }, message } } };
  value(await publishFeedCard(fixture.output, envelope));
  value(await publishFeedCard(fixture.output, { ...envelope, revision: 2, issuanceId: "unrelated-new-issuance", kind: "post", payload: {} }));
  const loaded = await fixture.source.load();
  const restored = loaded.entries.find((entry) => entry.state.card.cardId === parent.cardId);
  expect(restored?.owner?.threads).toContainEqual(message);
  expect(loaded.entries.find((entry) => entry.state.card.cardId === envelope.cardId)?.state.card.issuanceId).toBe("unrelated-new-issuance");
});
