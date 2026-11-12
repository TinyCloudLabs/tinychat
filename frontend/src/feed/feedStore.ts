import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  appendFeedResponse,
  appendFeedMessage,
  feedResourceNames,
  getFeedCardState,
  listFeedCards,
  listFeedCardHistory,
  listFeedResponses,
  readFeedResponseHandling,
  type FeedDatabase,
  type FeedCardIdentity,
  type FeedCard,
  type FeedCardState,
  type FeedReadDatabase,
  type FeedResponsePayload,
  type NewFeedResponse,
  type FeedHooks,
  type FeedOwnerView,
  type FeedResponse,
  type FeedSelector,
  type FeedSource,
} from "@tinycloud/sdk-services/feed";
import { getSetting, setSetting } from "../lib/threadStore";
import { storageScopeFor, trackStorageWrites } from "../lib/storageStatus";
import { THREADS_SQL_DB_NAME } from "../lib/threadKeys";
import { accountCacheKey, clearLocalMarker, hasLocalMarker, readLocal, setLocalMarker, writeLocal } from "../lib/localFirst/localCache";
import { foregroundDatabase } from "../lib/localFirst/requestLanes";
import type { HeldAnswerOutcome, HomeFeedEntry, HomeFeedSaveOptions, HomeFeedSnapshot, HomeFeedSource, HomeFeedViewEvent } from "./feedStoreTypes";
import { emptySitrepOwnerData, isClosed, jsonValue, ownerThreadResponseKey, parseSitrepCardPayload, parseOfficerThreadEvent, validPreparedIdentity, validateSitrepAction, safeSitrepActionSummary, type SitrepAction } from "@tinyboilerplate/core/feed/sitrep";
import { OWNER_EVENT_SCHEMA, readPrivateOwnerState, savePrivateOwnerState, savePrivateHeldNote, savePrivateGroupPriority, combineOwnerData } from "./sitrepOwnerStore";
import { OWNER_IMPORT_SCHEMA, OwnerArchiveCache } from "./sitrepArchiveStore";
import { TypedFeedHistory } from "./loadTypedFeed";
import { ownerCardKey } from "./feedIdentity";
import { privateFeedDatabase, parseOwnerJSON } from "./privateFeedDatabase";
import { clearHeldAnswers, heldAnswers, holdAnswer, isHeld, releaseAnswer, type HeldAnswer } from "./answerOutbox";
import { isReplyOnlyRevision, storedRevisionEntry } from "./replyOnlyRevision";

function sameIdentity(a: FeedCardIdentity, b: FeedCardIdentity) { return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId; }

export const HOME_FEED_RESOURCE = "xyz.tinycloud.tinychat/home_feed";
export const HOME_FEED_DEFAULT_KEY = "home-feed-default-view";
const RECONCILE_MS = 5 * 60_000;
/** How long a hidden page keeps its live-update stream; a shorter absence needs no catch-up of its own. */
const FRESH_MS = 60_000;
/** The longest the first load waits for the live-update stream before reading without it. */
const COVER_WAIT_MS = 5_000;
/** Bump when the registry schema batch below changes, so devices re-run it once. */
const FEED_SCHEMA_VERSION = 1;

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Home feed storage failed");
  return result.data as T;
}

async function cardHistory(output: FeedReadDatabase): Promise<FeedCard[]> {
  const cards: FeedCard[] = [];
  let afterIdentity: FeedCardIdentity | undefined;
  for (;;) {
    const page = unwrap(await listFeedCardHistory(output, { afterIdentity, limit: 1000 }));
    cards.push(...page.cards);
    if (!page.hasMore) return cards;
    if (!page.nextIdentity || (afterIdentity && sameIdentity(page.nextIdentity, afterIdentity))) throw new Error("Output history page did not advance its full identity");
    afterIdentity = page.nextIdentity;
  }
}

async function allResponses(responses: FeedReadDatabase): Promise<FeedResponse[]> {
  const all: FeedResponse[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = unwrap(await listFeedResponses(responses, { afterSequence, limit: 1000 }));
    all.push(...page);
    if (page.length < 1000) return all;
    afterSequence = page[page.length - 1]!.sequence;
  }
}

/** The feed's definitive no to a write (invalid for this card), as opposed to a failed transport. */
class RefusedWrite extends Error {}

/** An option's label as the answered revision published it (a typed question's, or the card's choice). */
function optionLabel(card: FeedCard, choiceId: string): string | undefined {
  const typed = parseSitrepCardPayload(card.payload?.sitrep);
  const options = typed?.record.kind === "ask" ? typed.record.options : card.choices ?? [];
  return options.find((option) => option.id === choiceId)?.label;
}

/** The outbox entry for an answer: only what rebuilds it (see answerOutbox.ts). */
function heldAnswerOf(entry: HomeFeedEntry, response: NewFeedResponse, payload?: FeedResponsePayload): HeldAnswer {
  const data = payload?.type === "sitrep.answer" && payload.data && typeof payload.data === "object" && !Array.isArray(payload.data) ? payload.data : undefined;
  const choiceId = data ? data.choice : response.choiceId;
  const text = data ? data.text : response.text;
  const action = data?.action;
  return {
    sourceId: entry.source.sourceId, cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId,
    ...(typeof choiceId === "string" && choiceId ? { choiceId } : {}),
    ...(typeof text === "string" && text ? { text } : {}),
    ...(action === "answer" || action === "accept-default" ? { action } : {}),
    ...(response.supersedesResponseId ? { supersedesResponseId: response.supersedesResponseId } : {}),
    at: response.createdAt,
  };
}

/** The answer exactly as the card built it when the page closed: same header, same payload, same responseId. */
function rebuildAnswer(held: HeldAnswer, card: FeedCard): { response: NewFeedResponse; payload?: FeedResponsePayload } {
  const header = {
    responseId: held.responseId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId,
    kind: held.supersedesResponseId ? "followup" as const : "answer" as const,
    ...(held.supersedesResponseId ? { supersedesResponseId: held.supersedesResponseId } : {}),
    createdAt: held.at,
  };
  const typed = parseSitrepCardPayload(card.payload?.sitrep);
  if (!typed) return { response: { ...header, ...(held.choiceId ? { choiceId: held.choiceId } : {}), ...(held.text ? { text: held.text } : {}) } };
  let action: SitrepAction;
  try {
    action = validateSitrepAction(typed.record, "sitrep.answer", { askId: typed.record.id, action: held.action ?? "answer", ...(held.choiceId ? { choice: held.choiceId } : {}), text: held.text ?? "", at: held.at }, new Date().toISOString());
  } catch (error) { throw new RefusedWrite(error instanceof Error ? error.message : "Invalid held answer"); }
  return {
    response: { ...header, text: safeSitrepActionSummary(action), ...(held.choiceId && card.choices?.some((option) => option.id === held.choiceId) ? { choiceId: held.choiceId } : {}) },
    payload: { type: "sitrep.answer", version: 1, data: jsonValue(action.value) },
  };
}
/** What the device keeps of the feed between opens: the last loaded snapshot and its agents. */
interface LocalFeed {
  snapshot: HomeFeedSnapshot;
  sources: FeedSource[];
}

/**
 * The same state `getFeedCardState` reads, built from rows the load already
 * holds: the listed card, its newest answer or follow-up from the response
 * history, and that response's handling. Saves two reads per card.
 */
async function stateFromLoaded(output: FeedDatabase, card: FeedCard, history: readonly FeedResponse[]): Promise<FeedCardState> {
  let response: FeedResponse | null = null;
  for (const candidate of history) {
    if ((candidate.kind === "answer" || candidate.kind === "followup") && (!response || candidate.sequence > response.sequence)) response = candidate;
  }
  if (!response) return { card, response: null, acknowledgement: null, outcome: null };
  const handling = await readFeedResponseHandling(output, response);
  if (!handling.ok && handling.error.code !== "NOT_FOUND") throw new Error(handling.error.message);
  return { card, response, acknowledgement: handling.ok ? handling.data.acknowledgement : null, outcome: handling.ok ? handling.data.outcome : null };
}

const sourcesByClient = new WeakMap<TinyCloudWeb, HomeFeedSource>();

/**
 * One feed source per signed-in client, so leaving and returning to the Feed
 * keeps its stream, caches and schema check instead of starting over.
 */
export function homeFeedSourceFor(tcw: TinyCloudWeb): HomeFeedSource {
  let source = sourcesByClient.get(tcw);
  if (!source) {
    source = createHomeFeedSource(tcw);
    sourcesByClient.set(tcw, source);
  }
  return source;
}

export function createHomeFeedSource(tcw: TinyCloudWeb): HomeFeedSource {
  const sessionSpace = tcw.spaceId;
  if (!sessionSpace) throw new Error("Home feed requires a signed-in TinyCloud space");
  const space: string = sessionSpace;
  function assertAccount() { if (tcw.spaceId !== space) throw new Error("Home account changed; open its current feed"); }
  const scope = storageScopeFor(tcw);
  const db = (resource: string) => privateFeedDatabase(trackStorageWrites(foregroundDatabase(tcw.sql.db(resource)), scope), assertAccount);
  const registry = db(HOME_FEED_RESOURCE);
  const archives = new OwnerArchiveCache(registry);
  const typedHistory = new TypedFeedHistory();
  const localKey = accountCacheKey(typeof tcw.did === "string" && tcw.did ? tcw.did : space, "home-feed");
  const schemaMarker = `tinychat:feed-schema:v${FEED_SCHEMA_VERSION}:${space}`;
  let schema: Promise<void> | undefined;
  let loadedOnce = false;
  let sources: FeedSource[] = [];
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let streamKey = "";
  let streamHooks: FeedHooks | undefined;
  let wakeTimer: number | undefined;
  let renewal: number | undefined;
  let streamError: Error | undefined;
  let streamReady = false;
  const waiters = new Set<() => void>();
  let localReads = 0;
  let hiddenAt: number | undefined;
  let hiddenTimer: number | undefined;
  // The fingerprint read at the last ready stream; the shown feed holds every
  // write it counts. Cleared when a load fails, since then it may not.
  let baseline: string | undefined;
  let loadsBegun = 0;
  let loadFailures = 0;

  // The registry tables only ever need creating once per account: after the
  // first success this device skips the write on every later open.
  function ensureSchema(): Promise<void> {
    if (!schema && hasLocalMarker(schemaMarker)) schema = Promise.resolve();
    schema ??= (async () => {
      unwrap(await registry.batch([
        { sql: `CREATE TABLE IF NOT EXISTS feed_agents (
          agent_id TEXT PRIMARY KEY, agent_did TEXT NOT NULL, label TEXT NOT NULL,
          output_resource TEXT NOT NULL UNIQUE, response_resource TEXT NOT NULL UNIQUE,
          authorization_json TEXT NOT NULL
        )` },
        { sql: `CREATE TABLE IF NOT EXISTS feed_view_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
          card_id TEXT NOT NULL, revision INTEGER NOT NULL, issuance_id TEXT NOT NULL,
          kind TEXT NOT NULL, created_at TEXT NOT NULL,
          snoozed_until TEXT
        )` },
        { sql: OWNER_EVENT_SCHEMA },
        { sql: OWNER_IMPORT_SCHEMA },
      ]));
      setLocalMarker(schemaMarker);
    })().catch((error: unknown) => { schema = undefined; throw error; });
    return schema;
  }

  function wake() {
    if (wakeTimer || !listeners.size) return;
    wakeTimer = window.setTimeout(() => {
      wakeTimer = undefined;
      for (const listener of listeners) listener();
    }, 50);
  }

  function release() {
    for (const done of [...waiters]) done();
  }

  function stop() {
    controller?.abort(); controller = undefined;
    streamReady = false;
    release();
  }

  function connect(force = false) {
    // The device's copy names the agents to subscribe to; wait for it rather
    // than open a stream that its answer would replace.
    if (!listeners.size || document.visibilityState === "hidden" || localReads) return;
    const resources = [HOME_FEED_RESOURCE, THREADS_SQL_DB_NAME, ...sources.flatMap((source) => [source.output.database, source.responses.database])];
    const nextKey = JSON.stringify(resources);
    const hooks: FeedHooks = tcw.hooks;
    if (!force && controller && !controller.signal.aborted && streamKey === nextKey && streamHooks === hooks) return;
    controller?.abort();
    streamReady = false;
    const request = new AbortController();
    controller = request;
    streamKey = nextKey;
    streamHooks = hooks;
    void (async () => {
      try {
        const subscriptions = resources.map((pathPrefix) => ({ space, service: "sql" as const, pathPrefix }));
        for await (const _event of hooks.subscribe(subscriptions, {
          signal: request.signal, ttlSeconds: 300,
          onReady: () => { if (!request.signal.aborted) void catchUp(request); },
        })) {
          if (!request.signal.aborted) wake();
        }
        if (!request.signal.aborted) throw new Error("Home feed notifications disconnected");
      } catch (error) {
        if (!request.signal.aborted) {
          streamReady = false;
          release();
          streamError = error instanceof Error ? error : new Error(String(error));
          wake();
        }
      }
    })();
  }

  /**
   * One cheap read per database the feed shows, all in one round. Every feed
   * table only appends (plain INSERTs, and the SDK's ON CONFLICT DO NOTHING),
   * so a row count plus the highest rowid changes with any write; the agent
   * registry and the default view are compared by value. A table `readFeed`
   * starts reading belongs here too.
   */
  async function fingerprint(): Promise<string> {
    const tally = async (database: FeedDatabase, tables: readonly string[], columns: readonly string[] = []) => unwrap(await database.query(
      `SELECT ${[...columns, ...tables.map((table) => `(SELECT count(*) || ':' || ifnull(max(rowid), 0) FROM ${table})`)].join(", ")}`, [],
    )).rows;
    const agents = "(SELECT group_concat(quote(agent_id) || quote(agent_did) || quote(label) || quote(output_resource) || quote(response_resource) || quote(authorization_json), ',') FROM (SELECT * FROM feed_agents ORDER BY agent_id))";
    return JSON.stringify(await Promise.all([
      tally(registry, ["feed_view_events", "feed_owner_events", "feed_owner_imports"], [agents]),
      getSetting(tcw, HOME_FEED_DEFAULT_KEY),
      ...sources.flatMap((source) => [
        tally(db(source.output.database), ["feed_cards", "feed_handling"]),
        tally(db(source.responses.database), ["feed_responses", "feed_response_payloads"]),
      ]),
    ]));
  }

  /**
   * Every ready stream (the first connection, the SDK's reconnects and ticket
   * renewals, a resume) may follow a gap that no notification covers, since
   * notifications are not replayed. Instead of reloading, compare fingerprints:
   * a write during the gap changes it. Writes while a stream is ready arrive as
   * notifications and reload on their own.
   */
  async function catchUp(request: AbortController) {
    const recovering = streamError !== undefined;
    streamError = undefined;
    streamReady = true;
    release();
    const previous = baseline;
    const begun = loadsBegun;
    const failures = loadFailures;
    const current = await fingerprint().catch(() => undefined);
    if (request.signal.aborted) return;
    baseline = loadFailures === failures ? current : undefined;
    // With no earlier fingerprint, the feed can only lack a write when a load
    // began before this stream was ready. A load another view starts meanwhile
    // may have begun before the gap write landed, so it never cancels this one.
    const stale = previous === undefined ? begun > 0 : current === undefined || current !== previous;
    if (stale || recovering) wake();
  }

  /** Lets the first load start under a ready stream, so that stream's ready needs no second load. */
  function streamCovered(): Promise<void> {
    if (loadsBegun || streamReady || streamError || !listeners.size || document.visibilityState === "hidden") return Promise.resolve();
    // The app's TypeScript lib predates Promise.withResolvers.
    return new Promise((resolve) => {
      const done = () => { window.clearTimeout(timer); waiters.delete(done); resolve(); };
      const timer = window.setTimeout(done, COVER_WAIT_MS);
      waiters.add(done);
    });
  }

  function foreground() {
    if (document.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      window.clearTimeout(hiddenTimer);
      hiddenTimer = window.setTimeout(() => {
        hiddenTimer = undefined;
        if (document.visibilityState === "hidden") stop();
      }, FRESH_MS);
    } else {
      window.clearTimeout(hiddenTimer); hiddenTimer = undefined;
      const away = hiddenAt === undefined ? 0 : Date.now() - hiddenAt;
      hiddenAt = undefined;
      // A stream that outlived a short absence missed nothing, and one that
      // broke reconnects and checks. After a long one, or once the stream has
      // failed for good, start a new stream: its ready runs the single
      // freshness check.
      connect(away > FRESH_MS || streamError !== undefined);
    }
  }

  function assertEntryScope(entry: HomeFeedEntry, identity: FeedCardIdentity = entry.state.card) {
    const source = sources.find((candidate) => candidate.sourceId === entry.source.sourceId);
    if (tcw.spaceId !== space || !source || source.agentDid !== entry.source.agentDid || source.output.spaceId !== space || source.responses.spaceId !== space || source.output.database !== entry.source.output.database || source.responses.database !== entry.source.responses.database || !sameIdentity(identity, entry.state.card)) throw new Error("Home action no longer matches this account and registered card identity");
  }

  async function appendView(entry: HomeFeedEntry, kind: "seen" | "snoozed", until?: string) {
    assertEntryScope(entry);
    await ensureSchema();
    const card = entry.state.card;
    unwrap(await registry.execute(
      "INSERT INTO feed_view_events (agent_id,card_id,revision,issuance_id,kind,created_at,snoozed_until) VALUES (?,?,?,?,?,?,?)",
      [entry.source.sourceId, card.cardId, card.revision, card.issuanceId, kind, new Date().toISOString(), until ?? null],
    ));
  }

  async function saveResponse(entry: HomeFeedEntry, response: NewFeedResponse, payload?: FeedResponsePayload, options?: HomeFeedSaveOptions) {
    assertEntryScope(entry, response);
    let approval = false;
    if (payload?.type.startsWith("sitrep.")) {
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      if (!typed || payload.version !== 1) throw new Error("Unsupported typed Home response");
      const action = validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString());
      if (action.type !== "sitrep.answer" && action.type !== "sitrep.claim") throw new Error("Owner updates must not be submitted as question answers");
      approval = typed.record.kind === "approval";
      response = { ...response, text: safeSitrepActionSummary(action) };
    }
    // Before the first await: a page that closes mid-write runs only this synchronous part for certain.
    if (options?.hold) holdAnswer(space, heldAnswerOf(entry, response, payload));
    const release = () => { if (options?.hold) releaseAnswer(space, { sourceId: entry.source.sourceId, ...response }); };
    if (approval) {
      const latest = unwrap(await listFeedCards(db(entry.source.output.database))).find((card) => card.cardId === response.cardId);
      if (!latest || latest.revision !== response.revision || latest.issuanceId !== response.issuanceId) throw new Error("Approval was re-issued; open its current issuance");
    }
    const result = await appendFeedResponse(db(entry.source.output.database), db(entry.source.responses.database), response, payload);
    // A definitive refusal clears the hold; a failed transport keeps it, so the answer still goes at the next launch.
    if (!result.ok && result.error.code === "INVALID_INPUT") { release(); throw new RefusedWrite(result.error.message); }
    const saved = unwrap(result);
    release();
    return saved;
  }

  /**
   * Where a held answer may still land: its own issuance while that is the card's latest and
   * still open. A plain card whose later revisions only appended agent replies is the same
   * request: an unanswered card's answer moves to the latest revision, and a follow-up stays
   * on the issuance it changes. Otherwise nothing is sent: the agent closed, ended or expired
   * the request ("closed"), or a newer revision changed it ("replaced").
   */
  function heldAnswerTarget(source: FeedSource, held: HeldAnswer, revisions: readonly FeedCard[], latest: FeedCard | undefined): FeedCardIdentity | "closed" | "replaced" {
    const answered = revisions.find((card) => sameIdentity(card, held));
    if (!latest || !answered || !latest.needsResponse) return "closed";
    const typed = parseSitrepCardPayload(latest.payload?.sitrep);
    if (typed && isClosed(typed.record)) return "closed";
    if (sameIdentity(latest, held)) return latest;
    if (typed || latest.payload?.sitrepThread !== undefined) return "replaced";
    let previous = answered;
    for (const card of revisions.filter((candidate) => candidate.revision > answered.revision)) {
      if (!isReplyOnlyRevision(storedRevisionEntry(source, previous), storedRevisionEntry(source, card))) return "replaced";
      previous = card;
    }
    if (!sameIdentity(previous, latest)) return "replaced";
    return held.supersedesResponseId ? answered : latest;
  }

  async function loadFeed(focused?: HomeFeedEntry): Promise<HomeFeedSnapshot> {
    assertAccount();
    await streamCovered();
    loadsBegun++;
    try {
      return await readFeed(focused);
    } catch (error) {
      loadFailures++;
      baseline = undefined;
      throw error;
    }
  }

  async function readFeed(focused?: HomeFeedEntry): Promise<HomeFeedSnapshot> {
    const readRegistry = async () => {
      await ensureSchema();
      const [agents, events] = await Promise.all([
        registry.query("SELECT agent_id,agent_did,label,output_resource,response_resource,authorization_json FROM feed_agents ORDER BY agent_id", []),
        registry.query("SELECT agent_id,card_id,revision,issuance_id,kind,created_at,snoozed_until,seq FROM feed_view_events ORDER BY seq", []),
      ]);
      return { agents, events };
    };
    await ensureSchema();
    const [firstRows, savedDefault] = await Promise.all([readRegistry(), getSetting(tcw, HOME_FEED_DEFAULT_KEY)]);
    let registryRows = firstRows;
    // The device skipped the registry CREATE batch on its marker. Feed errors are
    // redacted ("SQL operation failed"), so a missing table can't be told apart:
    // when these reads fail, drop the marker and read once more after the batch.
    if ((!registryRows.agents.ok || !registryRows.events.ok) && hasLocalMarker(schemaMarker)) {
      clearLocalMarker(schemaMarker);
      schema = undefined;
      registryRows = await readRegistry();
    }
    const agentResult = registryRows.agents;
    const eventResult = registryRows.events;
    // The node authorizes the full resource but stores by basename. Reject
    // aliases here instead of accidentally merging two agents' databases.
    const basenames = new Set([HOME_FEED_RESOURCE.split("/").at(-1)!, THREADS_SQL_DB_NAME.split("/").at(-1)!]);
    sources = unwrap(agentResult).rows.map((row) => {
      const [id, did, label, output, responses, provenance] = row as unknown[];
      if (![id, did, label, output, responses, provenance].every((value) => typeof value === "string" && value.length)) throw new Error("Invalid Home feed registry entry");
      // Provenance is retained for the connection owner, never interpreted as
      // authority. Only the actual signed session authorizes these handles.
      parseOwnerJSON(provenance as string, "Invalid persisted Home grant provenance JSON");
      const prefix = "xyz.tinycloud.tinychat/feed";
      const token = String(output).slice(`${prefix}/feed_output_`.length);
      const expected = unwrap(feedResourceNames(prefix, token));
      if (output !== expected.outputResource || responses !== expected.responseResource) throw new Error("Invalid per-agent Home feed resource pair");
      for (const resource of [output as string, responses as string]) {
        const basename = resource.split("/").at(-1)!;
        if (basenames.has(basename)) throw new Error("Home feed resources must have distinct per-agent database names");
        basenames.add(basename);
      }
      return {
        sourceId: id as string, agentDid: did as string, label: label as string,
        output: { spaceId: space, database: output as string },
        responses: { spaceId: space, database: responses as string },
      };
    });
    connect();
    // Owner archives and private state run beside the per-agent card reads
    // below instead of before them; both are needed only to assemble entries.
    const ownerData = archives.load(sources).then(async (imported) => ({ imported, privateState: await readPrivateOwnerState(registry, imported.scopes) }));
    ownerData.catch(() => {}); // awaited below; never an unhandled rejection meanwhile
    const views = new Map<string, FeedOwnerView>();
    const events = new Map<string, HomeFeedViewEvent[]>();
    for (const row of unwrap(eventResult).rows) {
      const [sourceId, cardId, revision, issuanceId, kind, at, until, sequence] = row as unknown[];
      if (kind !== "seen" && kind !== "snoozed") throw new Error("Invalid Home feed view event");
      const key = JSON.stringify([sourceId, cardId, revision, issuanceId]);
      const view = views.get(key) ?? { sourceId: String(sourceId), cardId: String(cardId), revision: Number(revision), issuanceId: String(issuanceId) };
      if (kind === "seen") view.seenAt = String(at);
      if (kind === "snoozed") view.snoozedUntil = typeof until === "string" ? until : undefined;
      views.set(key, view);
      const history = events.get(key) ?? [];
      history.push({ sequence: Number(sequence), kind, createdAt: String(at), ...(typeof until === "string" ? { snoozedUntil: until } : {}) });
      events.set(key, history);
    }
    const perAgent = await Promise.all(sources.map(async (source) => {
      const output = db(source.output.database);
      const responses = db(source.responses.database);
      const historyKey = (identity: FeedCardIdentity) => JSON.stringify([source.sourceId, identity.cardId, identity.revision, identity.issuanceId]);
      const [cards, storedCards, histories] = await Promise.all([
        listFeedCards(output).then(unwrap),
        (async () => {
          const stored: FeedCard[] = [];
          let afterIdentity: FeedCardIdentity | undefined;
          for (;;) {
            const page = unwrap(await listFeedCardHistory(output, { afterIdentity, limit: 1000 }));
            stored.push(...page.cards);
            if (!page.hasMore) return stored;
            if (!page.nextIdentity || (afterIdentity && sameIdentity(page.nextIdentity, afterIdentity))) throw new Error("Output history page did not advance its full identity");
            afterIdentity = page.nextIdentity;
          }
        })(),
        (async () => {
          const byCard = new Map<string, FeedResponse[]>();
          let afterSequence = 0;
          for (;;) {
            const page = unwrap(await listFeedResponses(responses, { afterSequence, limit: 1000 }));
            for (const response of page) {
              const key = historyKey(response);
              const history = byCard.get(key) ?? [];
              history.push(response);
              byCard.set(key, history);
            }
            if (page.length < 1000) return byCard;
            afterSequence = page[page.length - 1]!.sequence;
          }
        })(),
      ]);
      const revisionsByCard = new Map<string, FeedCard[]>();
      for (const card of storedCards) {
        const revisions = revisionsByCard.get(card.cardId) ?? [];
        revisions.push(card);
        revisionsByCard.set(card.cardId, revisions);
      }
      const { imported, privateState } = await ownerData;
      const latestKeys = new Set(cards.map((card) => ownerCardKey(source.sourceId, card)));
      const loadCard = async (identity: FeedCardIdentity, providedState?: FeedCardState): Promise<HomeFeedEntry> => {
        const state = providedState ?? unwrap(await getFeedCardState(output, responses, identity));
        const key = JSON.stringify([source.sourceId, identity.cardId, identity.revision, identity.issuanceId]);
        const entry: HomeFeedEntry = {
          source, state,
          currentIssuance: latestKeys.has(key),
          view: views.get(key) ?? { sourceId: source.sourceId, cardId: identity.cardId, revision: identity.revision, issuanceId: identity.issuanceId },
          earlierRevisions: (revisionsByCard.get(identity.cardId) ?? []).filter((card) => card.revision < identity.revision),
          responses: histories.get(key) ?? [],
          viewEvents: events.get(key) ?? [],
        };
        return typedHistory.enrich(entry, output, responses, histories.get(key) ?? [], privateState.byCard, imported, privateState.groupPriorities);
      };
      const loadListed = async (card: FeedCard) => loadCard(card, await stateFromLoaded(output, card, histories.get(historyKey(card)) ?? []));
      const loadedEntries = await Promise.all(cards.map(loadListed));
      loadedEntries.push(...await Promise.all(storedCards.filter((card) => {
        const key = ownerCardKey(source.sourceId, card);
        const owner = imported.owners.get(key);
        const archivedHistory = !!(owner && (owner.answers.length || owner.claimDecisions.length || owner.threads.length || owner.states.length || owner.outboundNotes?.length || owner.heldNotes?.length || owner.deliveries.length)) || !!imported.historicalCommands.get(key)?.length;
        return !latestKeys.has(key) && (archivedHistory || card.payload?.sitrepThread !== undefined || histories.has(key) || privateState.byCard[key] !== undefined || events.get(key)?.some((event) => event.kind === "snoozed"));
      }).map(loadListed)));
      const entries: HomeFeedEntry[] = [];
      const historicalEntries: HomeFeedEntry[] = [];
      const retainedParents = new Map<string, HomeFeedEntry>();
      const officerMessages = new Map<string, { target: HomeFeedEntry; parsed: NonNullable<ReturnType<typeof parseOfficerThreadEvent>>; outputs: HomeFeedEntry[]; conflict: boolean }>();
      for (const entry of loadedEntries) {
        const event = entry.state.card.payload?.sitrepThread;
        if (event === undefined) {
          const key = ownerCardKey(source.sourceId, entry.state.card);
          if (!imported.retired.has(key)) (latestKeys.has(key) ? entries : historicalEntries).push(entry);
          continue;
        }
        if (!event || typeof event !== "object" || !("parent" in event) || !validPreparedIdentity(event.parent) || entry.state.card.needsResponse) { entries.push(entry); continue; }
        const parentKey = ownerCardKey(source.sourceId, event.parent);
        let parent = loadedEntries.find((candidate) => ownerCardKey(source.sourceId, candidate.state.card) === parentKey) ?? retainedParents.get(parentKey);
        if (!parent) {
          const result = await getFeedCardState(output, responses, event.parent);
          if (!result.ok) {
            if (result.error.code === "NOT_FOUND") { entries.push(entry); continue; }
            throw new Error(result.error.message);
          }
          parent = await loadCard(event.parent, result.data);
          retainedParents.set(parentKey, parent);
        }
        const typed = parseSitrepCardPayload(parent.state.card.payload?.sitrep);
        const parsed = typed && typed.record.kind === parent.state.card.kind ? parseOfficerThreadEvent(event, typed.record) : null;
        const replyTo = parsed?.message.side === "officer" ? parsed.message.replyTo : undefined;
        if (!parsed || (replyTo && !parent.owner?.threads.some((message) => message.side === "sam" && message.messageId === replyTo))) { entries.push(entry); continue; }
        const key = JSON.stringify([parentKey, ownerThreadResponseKey(parsed.message)]);
        const pending = officerMessages.get(key);
        if (pending) {
          pending.outputs.push(entry);
          if (JSON.stringify(pending.parsed.message) !== JSON.stringify(parsed.message)) pending.conflict = true;
        } else officerMessages.set(key, { target: parent, parsed, outputs: [entry], conflict: false });
      }
      for (const pending of officerMessages.values()) {
        const { target, parsed, outputs } = pending;
        const existing = target.owner?.threads.find((message) => message.side === "officer" && ownerThreadResponseKey(message) === ownerThreadResponseKey(parsed.message));
        if (pending.conflict || (existing && JSON.stringify(existing) !== JSON.stringify(parsed.message))) { entries.push(...outputs); continue; }
        target.owner ??= emptySitrepOwnerData();
        if (!existing) target.owner.threads.push(parsed.message);
        const output = outputs[0];
        if (!output) throw new Error("Officer output identity is missing");
        (target.owner.threadOrigins ??= {})[ownerThreadResponseKey(parsed.message)] ??= { kind: "agent-output", sourceId: source.sourceId, cardId: output.state.card.cardId, revision: output.state.card.revision, issuanceId: output.state.card.issuanceId };
      }
      for (const parent of retainedParents.values()) {
        if (!latestKeys.has(ownerCardKey(source.sourceId, parent.state.card)) && !historicalEntries.some((entry) => sameIdentity(entry.state.card, parent.state.card))) historicalEntries.push(parent);
      }
      let focusedEntry: HomeFeedEntry | undefined;
      if (focused?.source.sourceId === source.sourceId) {
        const identity = focused.state.card;
        focusedEntry = loadedEntries.find((entry) => sameIdentity(entry.state.card, identity))
          ?? retainedParents.get(ownerCardKey(source.sourceId, identity)) ?? await loadCard(identity);
      }
      return { sourceId: source.sourceId, entries, historicalEntries, focusedEntry, loadCard, retainedParents };
    }));
    const focusedEntry = perAgent.find((group) => group.focusedEntry)?.focusedEntry;
    if (focused && !focusedEntry) throw new Error("Focused card source is no longer registered");
    const { imported } = await ownerData;
    const related = new Map<string, HomeFeedEntry>();
    if (focusedEntry?.modelScope) {
      for (const member of imported.members.get(focusedEntry.modelScope) ?? []) {
        const key = ownerCardKey(member.sourceId, member.identity);
        if (imported.retired.has(key) || key === ownerCardKey(focusedEntry.source.sourceId, focusedEntry.state.card)) continue;
        const group = perAgent.find((candidate) => candidate.sourceId === member.sourceId);
        if (!group) throw new Error("Focused historical relationship has no registered source");
        const existing = [...group.entries, ...group.historicalEntries].find((entry) => ownerCardKey(entry.source.sourceId, entry.state.card) === key) ?? group.retainedParents.get(key);
        const entry = existing ?? await group.loadCard(member.identity);
        related.set(key, { ...entry, modelScope: focusedEntry.modelScope });
      }
    }
    const all = new Map(perAgent.flatMap((group) => group.entries).map((entry) => [ownerCardKey(entry.source.sourceId, entry.state.card), entry]));
    if (focusedEntry) all.set(ownerCardKey(focusedEntry.source.sourceId, focusedEntry.state.card), focusedEntry);
    const sitrep = combineOwnerData([...all.values()].flatMap((entry) => entry.owner ? [entry.owner] : []));
    const defaultSelector: FeedSelector = savedDefault === "information" || savedDefault === "both" ? savedDefault : "needs-action";
    const entries = perAgent.flatMap((group) => group.entries);
    const historicalEntries = perAgent.flatMap((group) => group.historicalEntries);
    loadedOnce = true;
    // The device's copy for the next open: the feed itself, not the card
    // the user happens to have open or a transient connection error.
    void writeLocal<LocalFeed>(localKey, { snapshot: { entries, historicalEntries, settings: { defaultSelector }, sitrep }, sources });
    return { entries, historicalEntries, settings: { defaultSelector }, sitrep, relatedEntries: [...related.values()], ...(focusedEntry ? { focusedEntry } : {}), ...(streamError ? { connectionError: `Live updates unavailable: ${streamError.message}` } : {}) };
  }

  return {
    load: (focused) => loadFeed(focused),
    async cached() {
      localReads++;
      try {
        const local = await readLocal<LocalFeed>(localKey);
        if (!local) return null;
        // Subscribe to every agent's databases from the first connection, so the
        // first network load does not have to re-subscribe.
        if (!loadedOnce && !sources.length) sources = local.value.sources;
        return local.value.snapshot;
      } finally {
        localReads--;
        connect();
      }
    },
    saveResponse,
    holdsAnswer(entry, responseId) {
      const card = entry.state.card;
      return isHeld(space, { sourceId: entry.source.sourceId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, responseId });
    },
    async flushHeldAnswers() {
      const outcomes: HeldAnswerOutcome[] = [];
      for (const held of heldAnswers(space)) {
        // Cleared meanwhile (sign-out gave up on this flush): an entry that hasn't started is never sent.
        if (!isHeld(space, held)) continue;
        const source = sources.find((candidate) => candidate.sourceId === held.sourceId);
        // Its agent is no longer connected: there is no card left to answer or to tell.
        if (!source) { releaseAnswer(space, held); continue; }
        const output = db(source.output.database);
        const responses = db(source.responses.database);
        try {
          const stored = (await allResponses(responses)).filter((response) => response.cardId === held.cardId && response.kind !== "message");
          // The write started before the page closed may have landed: then it is already sent.
          if (stored.some((response) => response.responseId === held.responseId)) { releaseAnswer(space, held); continue; }
          const revisions = (await cardHistory(output)).filter((card) => card.cardId === held.cardId).sort((a, b) => a.revision - b.revision);
          const latest = unwrap(await listFeedCards(output)).find((card) => card.cardId === held.cardId);
          const answered = revisions.find((card) => sameIdentity(card, held));
          const label = held.choiceId && answered ? optionLabel(answered, held.choiceId) : undefined;
          const refusal = (outcome: "closed" | "replaced" | "refused"): HeldAnswerOutcome => ({
            sourceId: held.sourceId, cardId: held.cardId, outcome,
            ...(label ? { choiceLabel: label } : {}),
            ...(outcome === "replaced" && answered ? { answered: storedRevisionEntry(source, answered) } : {}),
          });
          const target = heldAnswerTarget(source, held, revisions, latest);
          if (typeof target === "string") { releaseAnswer(space, held); outcomes.push(refusal(target)); continue; }
          // Nothing newer may be overwritten: the owner may have answered since, on another device or tab.
          // A held answer goes only to a card not answered from its answered revision on; a held follow-up
          // only while the answer it replaces is still the newest on its issuance.
          const newest = stored.filter((response) => sameIdentity(response, held)).sort((a, b) => a.sequence - b.sequence).at(-1);
          const newer = held.supersedesResponseId
            ? newest?.responseId !== held.supersedesResponseId
            : stored.some((response) => response.revision >= held.revision);
          // The card shows that newer answer; nothing else to say.
          if (newer) { releaseAnswer(space, held); continue; }
          const state = unwrap(await getFeedCardState(output, responses, target));
          // Again right before the write: only a write already started may finish after a clear.
          if (!isHeld(space, held)) continue;
          try {
            const rebuilt = rebuildAnswer(held, state.card);
            await saveResponse({ source, state, view: { sourceId: source.sourceId, cardId: target.cardId, revision: target.revision, issuanceId: target.issuanceId } }, rebuilt.response, rebuilt.payload);
          } catch (error) {
            // The feed's definitive no: the request no longer takes this answer.
            if (error instanceof RefusedWrite) { releaseAnswer(space, held); outcomes.push(refusal("refused")); continue; }
            throw error;
          }
          releaseAnswer(space, held);
          outcomes.push({ sourceId: held.sourceId, cardId: held.cardId, outcome: "sent" });
        } catch {
          // A failed transport keeps the answer for the next launch.
        }
      }
      return outcomes;
    },
    async sendMessage(entry, message, payload) {
      assertEntryScope(entry, message);
      if (payload?.type.startsWith("sitrep.")) {
        const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
        if (!typed || payload.version !== 1) throw new Error("Unsupported typed card message");
        const action = validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString());
        if (action.type === "sitrep.answer" || action.type === "sitrep.claim") throw new Error("Question decisions must use the answer action");
        if (action.type === "sitrep.state" && (action.value.notes !== undefined || action.value.snoozes !== undefined || action.value.snoozedUntil !== undefined || action.value.priority !== undefined || action.value.seenAt !== undefined || action.value.dismissedAt !== undefined || Object.keys(action.value.steps).length)) throw new Error("Private owner state cannot enter agent-readable messages");
        if (action.type === "sitrep.thread" && action.delivery) {
          const approved = (await archives.load(sources)).routes.get(ownerCardKey(entry.source.sourceId, entry.state.card));
          if (!approved || action.delivery.targets.some((target) => !approved.receiptRecipients.some((recipient) => recipient.recipientKey === target.recipientKey && recipient.runtimeTarget?.agentId === target.agentId && recipient.runtimeTarget.provider === target.provider))) throw new Error("Message destination is not an owner-approved runtime mapping");
        }
        if (action.type === "sitrep.thread" && action.value.resendOf) {
          const originalId = action.value.resendOf;
          if (!entry.owner?.threads.some((message) => message.side === "sam" && message.messageId === originalId && message.kind === typed.record.kind && message.id === typed.record.id)) throw new Error("Original immutable message is not available for an explicit resend");
        }
        message = { ...message, text: safeSitrepActionSummary(action) };
      }
      return unwrap(await appendFeedMessage(db(entry.source.output.database), db(entry.source.responses.database), message, payload));
    },
    async saveOwnerState(entry, event) { assertEntryScope(entry); await ensureSchema(); await savePrivateOwnerState(registry, entry, event); wake(); },
    async saveHeldNote(entry, note) { assertEntryScope(entry); await ensureSchema(); await savePrivateHeldNote(registry, entry, note); wake(); },
    async setGroupPriority(entry, group, on) { assertEntryScope(entry); await ensureSchema(); await savePrivateGroupPriority(registry, entry, group, on); wake(); },
    markSeen: (entry) => appendView(entry, "seen"),
    snooze: (entry, until) => appendView(entry, "snoozed", until),
    async setDefaultSelector(selector) { assertAccount(); await setSetting(tcw, HOME_FEED_DEFAULT_KEY, selector); },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        document.addEventListener("visibilitychange", foreground);
        renewal = window.setInterval(() => { if (document.visibilityState !== "hidden") connect(true); }, RECONCILE_MS);
        connect();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop();
          window.clearTimeout(wakeTimer); wakeTimer = undefined;
          window.clearTimeout(hiddenTimer); hiddenTimer = undefined; hiddenAt = undefined;
          window.clearInterval(renewal); renewal = undefined;
          document.removeEventListener("visibilitychange", foreground);
        }
      };
    },
  };
}

/** How long sign-out waits for this space's held answers to go before clearing them anyway. */
export const SIGN_OUT_FLUSH_MS = 3000;

/**
 * At sign-out, with the session still live: one try, at most `boundMs`, to send this space's held
 * answers through the same flush as a launch (the same checks, expiry included). Then every one is
 * cleared, sent or not, also after a failure or the bound. Nothing held: no request at all.
 * A flush still running at the bound finishes only the write it already started: the flush skips
 * every entry that is no longer held, so clearing the outbox stops the rest.
 */
export async function settleHeldAnswersForSignOut(tcw: TinyCloudWeb, boundMs = SIGN_OUT_FLUSH_MS): Promise<void> {
  const space = tcw.spaceId;
  if (!space) return;
  let timer: number | undefined;
  try {
    if (!heldAnswers(space).length) return;
    await Promise.race([
      (async () => {
        const source = createHomeFeedSource(tcw);
        await source.load();
        await source.flushHeldAnswers?.();
      })(),
      new Promise<void>((resolve) => { timer = window.setTimeout(resolve, boundMs); }),
    ]);
  } catch { /* Not sent: cleared below all the same. */ }
  finally {
    window.clearTimeout(timer);
    clearHeldAnswers(space);
  }
}
