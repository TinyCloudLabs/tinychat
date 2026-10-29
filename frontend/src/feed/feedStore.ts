import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  appendFeedResponse,
  appendFeedMessage,
  feedResourceNames,
  getFeedCardState,
  listFeedCards,
  listFeedCardHistory,
  listFeedResponses,
  type FeedCardIdentity,
  type FeedCard,
  type FeedCardState,
  type FeedHooks,
  type FeedOwnerView,
  type FeedResponse,
  type FeedSelector,
  type FeedSource,
} from "@tinycloud/sdk-services/feed";
import { getSetting, setSetting } from "../lib/threadStore";
import { storageScopeFor, trackStorageWrites } from "../lib/storageStatus";
import { THREADS_SQL_DB_NAME } from "../lib/threadKeys";
import type { HomeFeedEntry, HomeFeedSource, HomeFeedViewEvent } from "./feedStoreTypes";
import { emptySitrepOwnerData, ownerThreadResponseKey, parseSitrepCardPayload, parseOfficerThreadEvent, validPreparedIdentity, validateSitrepAction, safeSitrepActionSummary } from "@tinyboilerplate/core/feed/sitrep";
import { OWNER_EVENT_SCHEMA, readPrivateOwnerState, savePrivateOwnerState, savePrivateHeldNote, savePrivateGroupPriority, combineOwnerData } from "./sitrepOwnerStore";
import { OWNER_IMPORT_SCHEMA, OwnerArchiveCache } from "./sitrepArchiveStore";
import { TypedFeedHistory } from "./loadTypedFeed";
import { ownerCardKey } from "./feedIdentity";
import { privateFeedDatabase, parseOwnerJSON } from "./privateFeedDatabase";

function sameIdentity(a: FeedCardIdentity, b: FeedCardIdentity) { return a.cardId === b.cardId && a.revision === b.revision && a.issuanceId === b.issuanceId; }

export const HOME_FEED_RESOURCE = "xyz.tinycloud.tinychat/home_feed";
export const HOME_FEED_DEFAULT_KEY = "home-feed-default-view";
const RECONCILE_MS = 5 * 60_000;

function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T {
  if (!result.ok) throw new Error(result.error?.message ?? "Home feed storage failed");
  return result.data as T;
}

export function createHomeFeedSource(tcw: TinyCloudWeb): HomeFeedSource {
  const sessionSpace = tcw.spaceId;
  if (!sessionSpace) throw new Error("Home feed requires a signed-in TinyCloud space");
  const space: string = sessionSpace;
  function assertAccount() { if (tcw.spaceId !== space) throw new Error("Home account changed; open its current feed"); }
  const scope = storageScopeFor(tcw);
  const db = (resource: string) => privateFeedDatabase(trackStorageWrites(tcw.sql.db(resource), scope), assertAccount);
  const registry = db(HOME_FEED_RESOURCE);
  const archives = new OwnerArchiveCache(registry);
  const typedHistory = new TypedFeedHistory();
  let schema: Promise<void> | undefined;
  let sources: FeedSource[] = [];
  const listeners = new Set<() => void>();
  let controller: AbortController | undefined;
  let streamKey = "";
  let streamHooks: FeedHooks | undefined;
  let wakeTimer: number | undefined;
  let renewal: number | undefined;
  let streamError: Error | undefined;

  function ensureSchema(): Promise<void> {
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

  function connect(force = false) {
    if (!listeners.size || document.visibilityState === "hidden") return;
    const resources = [HOME_FEED_RESOURCE, THREADS_SQL_DB_NAME, ...sources.flatMap((source) => [source.output.database, source.responses.database])];
    const nextKey = JSON.stringify(resources);
    const hooks: FeedHooks = tcw.hooks;
    if (!force && controller && !controller.signal.aborted && streamKey === nextKey && streamHooks === hooks) return;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    streamKey = nextKey;
    streamHooks = hooks;
    void (async () => {
      try {
        const subscriptions = resources.map((pathPrefix) => ({ space, service: "sql" as const, pathPrefix }));
        for await (const _event of hooks.subscribe(subscriptions, {
          signal: request.signal, ttlSeconds: 300,
          onReady: () => { if (!request.signal.aborted) { streamError = undefined; wake(); } },
        })) {
          if (!request.signal.aborted) wake();
        }
        if (!request.signal.aborted) throw new Error("Home feed notifications disconnected");
      } catch (error) {
        if (!request.signal.aborted) {
          streamError = error instanceof Error ? error : new Error(String(error));
          wake();
        }
      }
    })();
  }

  function foreground() {
    if (document.visibilityState === "hidden") {
      controller?.abort(); controller = undefined;
    } else {
      connect(true);
      wake();
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

  return {
    async load(focused) {
      assertAccount();
      await ensureSchema();
      const [agentResult, eventResult, savedDefault, privateState] = await Promise.all([
        registry.query("SELECT agent_id,agent_did,label,output_resource,response_resource,authorization_json FROM feed_agents ORDER BY agent_id", []),
        registry.query("SELECT agent_id,card_id,revision,issuance_id,kind,created_at,snoozed_until,seq FROM feed_view_events ORDER BY seq", []),
        getSetting(tcw, HOME_FEED_DEFAULT_KEY),
        readPrivateOwnerState(registry),
      ]);
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
      const imported = await archives.load(sources);
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
        const cards = unwrap(await listFeedCards(output));
        const storedCards: FeedCard[] = [];
        let afterIdentity: FeedCardIdentity | undefined;
        for (;;) {
          const page = unwrap(await listFeedCardHistory(output, { afterIdentity, limit: 1000 }));
          storedCards.push(...page.cards);
          if (!page.hasMore) break;
          if (!page.nextIdentity || (afterIdentity && sameIdentity(page.nextIdentity, afterIdentity))) throw new Error("Output history page did not advance its full identity");
          afterIdentity = page.nextIdentity;
        }
        const histories = new Map<string, FeedResponse[]>();
        let afterSequence = 0;
        for (;;) {
          const page = unwrap(await listFeedResponses(responses, { afterSequence, limit: 1000 }));
          for (const response of page) {
            const key = JSON.stringify([source.sourceId, response.cardId, response.revision, response.issuanceId]);
            const history = histories.get(key) ?? [];
            history.push(response);
            histories.set(key, history);
          }
          if (page.length < 1000) break;
          afterSequence = page[page.length - 1]!.sequence;
        }
        const latestKeys = new Set(cards.map((card) => ownerCardKey(source.sourceId, card)));
        const loadCard = async (identity: FeedCardIdentity, providedState?: FeedCardState): Promise<HomeFeedEntry> => {
          const state = providedState ?? unwrap(await getFeedCardState(output, responses, identity));
          const key = JSON.stringify([source.sourceId, identity.cardId, identity.revision, identity.issuanceId]);
          const entry: HomeFeedEntry = {
            source, state,
            currentIssuance: latestKeys.has(key),
            view: views.get(key) ?? { sourceId: source.sourceId, cardId: identity.cardId, revision: identity.revision, issuanceId: identity.issuanceId },
            responses: histories.get(key) ?? [],
            viewEvents: events.get(key) ?? [],
          };
          return typedHistory.enrich(entry, output, responses, histories.get(key) ?? [], privateState.byCard, imported);
        };
        const loadedEntries = await Promise.all(cards.map((card) => loadCard(card)));
        loadedEntries.push(...await Promise.all(storedCards.filter((card) => {
          const key = ownerCardKey(source.sourceId, card);
          return !latestKeys.has(key) && (card.payload?.sitrepThread !== undefined || histories.has(key) || privateState.byCard[key] !== undefined || events.get(key)?.some((event) => event.kind === "snoozed"));
        }).map((card) => loadCard(card))));
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
      if (privateState.groupPriority) sitrep.groupPriority = { groups: { ...sitrep.groupPriority?.groups, ...privateState.groupPriority.groups }, updatedAt: privateState.groupPriority.updatedAt };
      const defaultSelector: FeedSelector = savedDefault === "information" || savedDefault === "both" ? savedDefault : "needs-action";
      return { entries: perAgent.flatMap((group) => group.entries), historicalEntries: perAgent.flatMap((group) => group.historicalEntries), settings: { defaultSelector }, sitrep, relatedEntries: [...related.values()], ...(focusedEntry ? { focusedEntry } : {}), ...(streamError ? { connectionError: `Live updates unavailable: ${streamError.message}` } : {}) };
    },
    async saveResponse(entry, response, payload) {
      assertEntryScope(entry, response);
      if (payload?.type.startsWith("sitrep.")) {
        const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
        if (!typed || payload.version !== 1) throw new Error("Unsupported typed Home response");
        const action = validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString());
        if (action.type !== "sitrep.answer" && action.type !== "sitrep.claim") throw new Error("Owner updates must not be submitted as question answers");
        if (typed.record.kind === "approval") {
          const latest = unwrap(await listFeedCards(db(entry.source.output.database))).find((card) => card.cardId === response.cardId);
          if (!latest || latest.revision !== response.revision || latest.issuanceId !== response.issuanceId) throw new Error("Approval was re-issued; open its current issuance");
        }
        response = { ...response, text: safeSitrepActionSummary(action) };
      }
      return unwrap(await appendFeedResponse(db(entry.source.output.database), db(entry.source.responses.database), response, payload));
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
        renewal = window.setInterval(() => { if (document.visibilityState !== "hidden") { connect(true); wake(); } }, RECONCILE_MS);
        connect();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          controller?.abort(); controller = undefined;
          window.clearTimeout(wakeTimer); wakeTimer = undefined;
          window.clearInterval(renewal); renewal = undefined;
          document.removeEventListener("visibilitychange", foreground);
        }
      };
    },
  };
}
