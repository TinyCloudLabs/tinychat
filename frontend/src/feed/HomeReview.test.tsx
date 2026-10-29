import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  feedResourceNames, getFeedCardState, initializeFeedDatabases,
  listFeedResponses, publishFeedCard, readFeedResponsePayload,
  type FeedCard, type FeedDatabase, type FeedSource,
} from "@tinycloud/sdk-services/feed";
import {
  answerKey, claimDecisionKey, prepareSitrepImport, threadKey,
  type PrepareSitrepImportInput, type PreparedSitrepImportBundle,
} from "@tinyboilerplate/core/feed/sitrep";
import { installDom } from "@/test/dom";
import { useLocalThreadStorage } from "../lib/threadStore";
import { FeedViewEntries } from "./FeedView";
import { createHomeFeedSource, HOME_FEED_RESOURCE } from "./feedStore";
import { archivePreparedOwnerBundle } from "./sitrepArchiveStore";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";
import type { HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

const PREFIX = "xyz.tinycloud.rocinante/";
const NONCE = "00000000000000000000000000000001";
const roots = new Set<Root>();
const databases: Database[] = [];
let restoreDom: (() => void) | undefined;
beforeEach(() => {
  setSystemTime(new Date(SITREP_NOW));
  restoreDom = installDom();
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  restoreDom?.(); restoreDom = undefined;
  for (const database of databases.splice(0)) database.close();
  setSystemTime();
});

function value<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Isolated Home SQL operation failed");
  return result.data as T;
}

// Same positional SQLite adapter as feedStore.test.ts; only the browser SDK
// transport is substituted. These tests do not claim auth or SSE runtime proof.
function sqliteHandle(database: Database): FeedDatabase {
  const execute: FeedDatabase["execute"] = async (sql, params = []) => {
    const result = database.query(sql).run(...params);
    return { ok: true, data: { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) } };
  };
  return {
    execute,
    query: async <T,>(sql: string, params: (string | number | null | Uint8Array)[] = []) => {
      const statement = database.query(sql);
      const rows = statement.values(...params) as T[][];
      return { ok: true, data: { columns: statement.columnNames, rows, rowCount: rows.length } };
    },
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

// Drive invalidation explicitly, without network, polling, fake history, or a
// replacement implementation of load/save. Every operation uses the real store.
function observedSource(tcw: TinyCloudWeb) {
  const actual = createHomeFeedSource(tcw);
  const listeners = new Set<() => void>();
  let pending: Promise<HomeFeedSnapshot> | undefined;
  const source: HomeFeedSource = {
    ...actual,
    load(focused) { pending = actual.load(focused); return pending; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  async function settle() {
    let current: typeof pending;
    do { current = pending; await act(async () => { await current; }); } while (pending !== current);
  }
  return { source, settle, async notify() { await act(async () => { for (const listener of listeners) listener(); }); await settle(); } };
}

type Agent = { source: FeedSource; output: FeedDatabase; responses: FeedDatabase };
async function ownerFixture() {
  const handles = new Map<string, { sqlite: Database; handle: FeedDatabase }>();
  function storage(resource: string) {
    let stored = handles.get(resource);
    if (!stored) {
      const sqlite = new Database(":memory:"); databases.push(sqlite);
      stored = { sqlite, handle: sqliteHandle(sqlite) }; handles.set(resource, stored);
    }
    return stored;
  }
  const spaceId = `isolated-home-review-${crypto.randomUUID()}`;
  const tcw = useLocalThreadStorage({ spaceId, hooks: {}, sql: { db: (resource: string) => storage(resource).handle } } as unknown as TinyCloudWeb);
  const fresh = () => observedSource(tcw);
  const initial = fresh(); await initial.source.load();
  await initial.source.setDefaultSelector("both");
  const registry = storage(HOME_FEED_RESOURCE);
  return {
    registry, fresh,
    async agent(token: string): Promise<Agent> {
      const names = value(feedResourceNames("xyz.tinycloud.tinychat/feed", token));
      const output = storage(names.outputResource).handle;
      const responses = storage(names.responseResource).handle;
      value(await initializeFeedDatabases({ output, responses }));
      const source: FeedSource = { sourceId: token, agentDid: `did:key:synthetic-${token}`, label: "Same publisher display name", output: { spaceId, database: names.outputResource }, responses: { spaceId, database: names.responseResource } };
      registry.sqlite.query("INSERT INTO feed_agents (agent_id,agent_did,label,output_resource,response_resource,authorization_json) VALUES (?,?,?,?,?,?)").run(source.sourceId, source.agentDid, source.label, source.output.database, source.responses.database, "{}");
      return { source, output, responses };
    },
  };
}

function typedCard(record: Record<string, unknown>, cardId: string): FeedCard {
  if (typeof record.kind !== "string" || typeof record.title !== "string" || typeof record.body !== "string" || typeof record.createdAt !== "string") throw new Error("Invalid synthetic typed card");
  return { cardId, revision: 1, issuanceId: `${cardId}-first-issuance`, kind: record.kind, needsResponse: true, title: record.title, body: record.body, urgency: 2, createdAt: record.createdAt, payload: { sitrep: { version: 1, record } } };
}
function identity(card: FeedCard) { return { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId }; }
function entryFor(snapshot: HomeFeedSnapshot, sourceId: string, cardId: string) {
  const entry = snapshot.entries.find((entry) => entry.source.sourceId === sourceId && entry.state.card.cardId === cardId);
  if (!entry) throw new Error("Synthetic published card was not loaded");
  return entry;
}
function button(host: ParentNode, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Expected visible action: ${label}`);
  return result;
}
async function mount(transport: ReturnType<typeof observedSource>) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={transport.source} />));
  await transport.settle();
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
async function click(transport: ReturnType<typeof observedSource>, element: HTMLElement) {
  await act(async () => element.click()); await transport.settle();
}
async function enterCode(input: HTMLInputElement, code: string) {
  expect(input.disabled).toBe(false);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    if (!setter) throw new Error("DOM input setter is missing");
    setter.call(input, code); input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function codeInput(host: ParentNode): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('[aria-label="Approval code"]');
  if (!input) throw new Error("The expected approval code input is missing");
  return input;
}
async function openCard(transport: ReturnType<typeof observedSource>, host: HTMLElement, title: string) {
  const card = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Cards in this view"] button')].find((candidate) => candidate.textContent?.includes(title));
  if (!card) throw new Error(`Published card is not visible in navigation: ${title}`);
  await click(transport, card);
}

for (const engagement of ["empty field focus", "consent link activation"] as const) {
  test(`${engagement} latches a folded approval before code entry; replacement receives no write until explicit navigation`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent("engagement");
    const ask = typedCard(syntheticRecord("ask"), "parent-question");
    const grant: Record<string, unknown> = { ...syntheticRecord("approval"), approvalType: "openkey", codeExpected: true, names: ["SYNTHETIC_KEY"], url: "https://openkey.so/delegate?fixture=engagement-original", forAsk: { id: "ask-synthetic" } };
    delete grant.approvalKind;
    const original = typedCard(grant, "folded-approval");
    value(await publishFeedCard(agent.output, ask)); value(await publishFeedCard(agent.output, original));
    const transport = owner.fresh(); const view = await mount(transport);
    await openCard(transport, view.host, ask.title);
    const input = codeInput(view.host);
    expect(input.value).toBe("");
    if (engagement === "empty field focus") {
      await act(async () => input.focus());
      expect(document.activeElement === input).toBe(true);
    } else {
      const link = view.host.querySelector<HTMLAnchorElement>('a[href="https://openkey.so/delegate?fixture=engagement-original"]');
      if (!link) throw new Error("Original approval consent link is missing");
      // Cancel navigation at document bubble phase, after React handles the
      // activation. No consent endpoint, window.open, or network call occurs.
      const preventNavigation = (event: Event) => { if (event.target === link) event.preventDefault(); };
      document.addEventListener("click", preventNavigation);
      try { await click(transport, link); } finally { document.removeEventListener("click", preventNavigation); }
    }
    const replacement: FeedCard = { ...original, revision: 2, issuanceId: "replacement-consent-issuance", payload: { sitrep: { version: 1, record: { ...grant, issuedAt: SITREP_NOW, url: "https://openkey.so/delegate?fixture=engagement-replacement" } } } };
    value(await publishFeedCard(agent.output, replacement)); await transport.notify();
    const afterReissue = codeInput(view.host);
    // A real user can only enter/click if the input is enabled. Before the fix
    // that incorrectly posts an old-consent code to the replacement issuance.
    if (!afterReissue.disabled) {
      await enterCode(afterReissue, "CODE-FROM-ORIGINAL-CONSENT");
      await click(transport, button(view.host, "Save code"));
    }
    expect(value(await listFeedResponses(agent.responses))).toEqual([]);
    expect(codeInput(view.host) === input).toBe(true);
    expect(input.disabled).toBe(true);
    expect(view.host.querySelector('[aria-label="Folded approval step"] code')?.textContent).toBe(`${original.cardId}/${original.revision}/${original.issuanceId}`);
    expect(value(await getFeedCardState(agent.output, agent.responses, identity(original))).response).toBeNull();
    await click(transport, button(view.host, "Open current approval"));
    const currentInput = codeInput(view.host);
    expect(currentInput === input).toBe(false);
    expect(currentInput.value).toBe("");
    await enterCode(currentInput, "FRESH-CODE-FROM-EXPLICIT-REPLACEMENT-CONSENT");
    await click(transport, button(view.host, "Save code"));
    const headers = value(await listFeedResponses(agent.responses));
    expect(headers).toHaveLength(1);
    expect(headers[0]).toMatchObject({ ...identity(replacement), kind: "answer" });
    const response = headers[0]; if (!response) throw new Error("Explicit replacement answer did not persist");
    expect(value(await readFeedResponsePayload(agent.responses, response))).toMatchObject({ type: "sitrep.answer", version: 1, data: { askId: grant.id, action: "code", issuedAt: SITREP_NOW, text: "FRESH-CODE-FROM-EXPLICIT-REPLACEMENT-CONSENT" } });
    expect(value(await getFeedCardState(agent.output, agent.responses, identity(original))).response).toBeNull();
  });
}

test("focused code-less folded confirmation keeps its original issuance until explicit navigation", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("confirmation-focus");
  const ask = typedCard(syntheticRecord("ask"), "confirmation-parent");
  const grant: Record<string, unknown> = { ...syntheticRecord("approval"), approvalType: "secret", codeExpected: false, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=confirmation-focus", forAsk: { id: "ask-synthetic" } };
  delete grant.approvalKind;
  const original = typedCard(grant, "folded-confirmation");
  value(await publishFeedCard(agent.output, ask)); value(await publishFeedCard(agent.output, original));
  const transport = owner.fresh(); const view = await mount(transport);
  await openCard(transport, view.host, ask.title);
  const confirmation = button(view.host, "I completed this step");
  await act(async () => confirmation.focus());
  expect(document.activeElement === confirmation).toBe(true);
  const replacement: FeedCard = { ...original, revision: 2, issuanceId: "replacement-confirmation-issuance", payload: { sitrep: { version: 1, record: { ...grant, issuedAt: SITREP_NOW } } } };
  value(await publishFeedCard(agent.output, replacement)); await transport.notify();
  const afterReissue = button(view.host, "I completed this step");
  if (!afterReissue.disabled) await click(transport, afterReissue);
  expect(value(await listFeedResponses(agent.responses))).toEqual([]);
  expect(afterReissue === confirmation).toBe(true);
  expect(afterReissue.disabled).toBe(true);
  expect(view.host.querySelector('[aria-label="Folded approval step"] code')?.textContent).toBe(`${original.cardId}/${original.revision}/${original.issuanceId}`);
  await click(transport, button(view.host, "Open current approval"));
  const current = button(view.host, "I completed this step");
  expect(current === confirmation).toBe(false);
  expect(current.disabled).toBe(false);
  await click(transport, current);
  const headers = value(await listFeedResponses(agent.responses));
  expect(headers).toHaveLength(1);
  const response = headers[0]; if (!response) throw new Error("Explicit replacement confirmation did not persist");
  expect(response).toMatchObject({ ...identity(replacement), kind: "answer" });
  expect(value(await readFeedResponsePayload(agent.responses, response))).toMatchObject({ type: "sitrep.answer", version: 1, data: { askId: grant.id, action: "done", text: "", issuedAt: SITREP_NOW } });
  expect(value(await getFeedCardState(agent.output, agent.responses, identity(original))).response).toBeNull();
});

function rawRow(sourceKey: string, record: unknown) {
  const bytes = Buffer.from(JSON.stringify(record), "utf8");
  return { sourceKey, sourceArea: "kv" as const, encoding: "base64" as const, rawBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
}
function archiveInput(agent: Agent, records: Record<string, unknown>[], origin: string): PrepareSitrepImportInput {
  return {
    source: { spaceId: origin, namespace: PREFIX, snapshotId: `${origin}-first`, completePrefixSnapshot: false }, frozenAt: SITREP_NOW,
    rows: records.map((record) => rawRow(`${PREFIX}board/${record.kind}/${record.id}.json`, record)),
    publishers: [{ publisherId: "original-publisher", agentId: agent.source.sourceId, agentDid: agent.source.agentDid, outputResource: agent.source.output.database, responseResource: agent.source.responses.database }],
    publisherBindings: records.map((record, index) => ({ sourceKey: `${PREFIX}board/${record.kind}/${record.id}.json`, publisherId: "original-publisher", identity: { cardId: `${origin}-card-${index}`, revision: 1, issuanceId: `${origin}-issuance-${index}` } })), recipients: [],
  };
}
async function publishBundle(agent: Agent, bundle: PreparedSitrepImportBundle) {
  for (const prepared of bundle.cards) value(await publishFeedCard(agent.output, prepared.canonicalCard));
}
async function commandOnlyArchive(owner: Awaited<ReturnType<typeof ownerFixture>>, agent: Agent) {
  const record = { ...syntheticRecord("task"), title: "Archive-only completion command" };
  const input = archiveInput(agent, [record], "command-origin");
  const stateKey = `${PREFIX}sam/state/task/task-synthetic.json`;
  input.rows.push(rawRow(stateKey, { kind: "task", id: "task-synthetic", steps: {}, doneAt: SITREP_NOW, updatedAt: SITREP_NOW }));
  const first = await prepareSitrepImport(input);
  const command = first.ownerResponses.find((response) => response.ownerEventKind === "state");
  if (!command) throw new Error("Valid historical task completion command was not prepared");
  await archivePreparedOwnerBundle(owner.registry.handle, first);
  const reset = await prepareSitrepImport({ ...input, source: { ...input.source, snapshotId: "command-origin-reset" }, rows: [rawRow(stateKey, { kind: "task", id: "task-synthetic", steps: {}, updatedAt: SITREP_NOW })], previous: first });
  await archivePreparedOwnerBundle(owner.registry.handle, reset); await publishBundle(agent, first);
  const card = first.cards[0]?.canonicalCard; if (!card) throw new Error("Archived task card is missing");
  return { card, command };
}
function responseCount(database: FeedDatabase) {
  return database.query<number>("SELECT COUNT(*) FROM feed_responses").then(value).then((result) => result.rows[0]?.[0]);
}

for (const history of ["answer", "claim", "thread", "command"] as const) {
  test(`fresh Home retains an old issuance with archive-only ${history} history, without restoring or dispatching it`, async () => {
    const owner = await ownerFixture(); const agent = await owner.agent("history");
    let original: FeedCard;
    if (history === "command") original = (await commandOnlyArchive(owner, agent)).card;
    else {
      const record = { ...syntheticRecord(history === "claim" ? "claim" : "ask"), title: `Archive-only ${history} card` };
      const input = archiveInput(agent, [record], `history-${history}`);
      if (history === "answer") input.rows.push(rawRow(answerKey("ask-synthetic", SITREP_NOW), { askId: "ask-synthetic", action: "answer", text: "Immutable archive-only answer", at: SITREP_NOW }));
      if (history === "claim") input.rows.push(rawRow(claimDecisionKey("T-001", SITREP_NOW, NONCE), { choice: "keep", note: "Immutable archive-only claim decision", at: SITREP_NOW }));
      if (history === "thread") input.rows.push(rawRow(threadKey("sam", "ask", "ask-synthetic", SITREP_NOW, NONCE), { kind: "ask", id: "ask-synthetic", text: "Immutable archive-only thread message", at: SITREP_NOW }));
      const bundle = await prepareSitrepImport(input); await archivePreparedOwnerBundle(owner.registry.handle, bundle); await publishBundle(agent, bundle);
      const card = bundle.cards[0]?.canonicalCard; if (!card) throw new Error("Prepared archive card is missing");
      original = card;
    }
    const before = entryFor(await owner.fresh().source.load(), agent.source.sourceId, original.cardId);
    if (history === "answer") expect(before.owner?.answers[0]?.value.text).toBe("Immutable archive-only answer");
    if (history === "claim") expect(before.owner?.claimDecisions[0]?.value).toMatchObject({ choice: "keep", note: "Immutable archive-only claim decision" });
    if (history === "thread") expect(before.owner?.threads[0]?.text).toBe("Immutable archive-only thread message");
    if (history === "command") {
      expect(before.historicalCommands?.[0]?.state.doneAt).toBe(SITREP_NOW);
      expect(before.owner?.states.some((state) => state.doneAt !== undefined)).toBe(false);
      expect(before.owner?.commands).toBeUndefined();
    }
    expect(await responseCount(agent.responses)).toBe(0);
    expect(owner.registry.sqlite.query("SELECT COUNT(*) AS count FROM feed_owner_events").get()).toEqual({ count: 0 });
    value(await publishFeedCard(agent.output, { ...original, revision: 2, issuanceId: "later-replacement-issuance", title: `Replacement of ${history} card` }));
    const fresh = owner.fresh(); const loaded = await fresh.source.load();
    const retained = loaded.historicalEntries?.find((entry) => entry.state.card.cardId === original.cardId && entry.state.card.revision === original.revision && entry.state.card.issuanceId === original.issuanceId);
    expect(retained?.state.card).toMatchObject(identity(original));
    expect(retained?.state.response).toBeNull();
    expect(retained?.responses).toEqual([]);
    const view = await mount(fresh); await click(fresh, button(view.host, "History"));
    await openCard(fresh, view.host, original.title);
    if (history === "answer") expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Immutable archive-only answer");
    if (history === "claim") expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Immutable archive-only claim decision");
    if (history === "thread") {
      await click(fresh, button(view.host, `Message ${agent.source.label}`));
      expect(view.host.querySelector('[aria-label="Card thread"]')?.textContent).toContain("Immutable archive-only thread message");
    }
    if (history === "command") expect(view.host.querySelector('[aria-label="Historical owner commands"]') !== null).toBe(true);
    expect(await responseCount(agent.responses)).toBe(0);
  });
}

test("command-only archive history remains visible after mutable owner state resets, without a restored response or live retry intent", async () => {
  const owner = await ownerFixture(); const agent = await owner.agent("commandonly");
  const { card, command } = await commandOnlyArchive(owner, agent);
  const fresh = owner.fresh(); const loaded = entryFor(await fresh.source.load(), agent.source.sourceId, card.cardId);
  expect(loaded.historicalCommands).toContainEqual(expect.objectContaining({ responseId: command.response.responseId, state: expect.objectContaining({ doneAt: SITREP_NOW }) }));
  expect(loaded.owner?.commands).toBeUndefined();
  expect(loaded.owner?.states[0]?.steps).toEqual({});
  expect(loaded.owner?.states[0]?.doneAt).toBeUndefined();
  expect(loaded.owner?.answers).toEqual([]); expect(loaded.owner?.threads).toEqual([]);
  expect(await responseCount(agent.responses)).toBe(0);
  const view = await mount(fresh); await click(fresh, button(view.host, "History"));
  await openCard(fresh, view.host, card.title);
  expect(view.host.querySelector('[aria-label="Historical owner commands"]') !== null).toBe(true);
  expect(await responseCount(agent.responses)).toBe(0);
});

async function expandGroups(transport: ReturnType<typeof observedSource>, host: HTMLElement) {
  for (const section of host.querySelectorAll<HTMLElement>('section[aria-label="Card group Release"]')) {
    const toggle = section.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
    if (toggle) await click(transport, toggle);
  }
}
function groupSection(host: HTMLElement, title: string): HTMLElement {
  const section = [...host.querySelectorAll<HTMLElement>('section[aria-label="Card group Release"]')].find((candidate) => candidate.textContent?.includes(title));
  if (!section) throw new Error(`Expected independent Release group containing ${title}`);
  return section;
}
function groupPressed(section: HTMLElement): boolean {
  const control = section.querySelector<HTMLButtonElement>('button[aria-pressed]');
  if (!control) throw new Error("Private group priority control is missing");
  return control.getAttribute("aria-pressed") === "true";
}

for (const scope of ["independent registered sources", "independent validated archive origins"] as const) {
  for (const operation of ["set", "clear"] as const) {
    test(`${operation} private Release priority stays in ${scope} after actual owner SQLite reload`, async () => {
      const owner = await ownerFixture(); const alpha = await owner.agent("priorityalpha");
      const beta = scope === "independent registered sources" ? await owner.agent("prioritybeta") : alpha;
      const cards: FeedCard[][] = [];
      for (const [index, agent] of [alpha, beta].entries()) {
        const records = [0, 1].map((number) => ({ ...syntheticRecord("task"), id: `release-${index}-${number}`, title: `Release origin ${index} task ${number}`, group: "Release" }));
        if (scope === "independent validated archive origins") {
          const bundle = await prepareSitrepImport(archiveInput(agent, records, `isolated-origin-${index}`));
          await archivePreparedOwnerBundle(owner.registry.handle, bundle); await publishBundle(agent, bundle);
          cards.push(bundle.cards.map((card) => card.canonicalCard));
        } else {
          const published = records.map((record, number) => typedCard(record, `release-${index}-${number}`));
          for (const card of published) value(await publishFeedCard(agent.output, card));
          cards.push(published);
        }
      }
      const first = cards[0]?.[0]; const other = cards[1]?.[0];
      if (!first || !other) throw new Error("Independent group fixture is incomplete");
      const transport = owner.fresh(); const snapshot = await transport.source.load();
      const entryA = entryFor(snapshot, alpha.source.sourceId, first.cardId);
      const entryB = entryFor(snapshot, beta.source.sourceId, other.cardId);
      if (scope === "independent validated archive origins") {
        expect(entryA.modelScope === entryB.modelScope).toBe(false);
        expect(entryA.source.sourceId).toBe(entryB.source.sourceId);
      } else expect(entryA.source.sourceId === entryB.source.sourceId).toBe(false);
      if (operation === "clear") {
        const save = transport.source.setGroupPriority;
        if (!save) throw new Error("Actual owner priority persistence is unavailable");
        await save(entryA, "Release", true); await save(entryB, "Release", true);
      }
      const view = await mount(transport); await expandGroups(transport, view.host);
      const groupA = groupSection(view.host, first.title);
      await click(transport, button(groupA, operation === "set" ? "Mark private group priority" : "Clear private group priority"));
      await view.unmount();
      const reopened = owner.fresh(); await reopened.source.load();
      const durable = await mount(reopened); await expandGroups(reopened, durable.host);
      expect(groupPressed(groupSection(durable.host, first.title))).toBe(operation === "set");
      expect(groupPressed(groupSection(durable.host, other.title))).toBe(operation === "clear");
      expect(await responseCount(alpha.responses)).toBe(0);
      if (beta !== alpha) expect(await responseCount(beta.responses)).toBe(0);
    });
  }
}
