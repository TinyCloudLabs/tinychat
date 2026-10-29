import type { FeedCardIdentity, FeedDatabase, FeedSource } from "@tinycloud/sdk-services/feed";
import { decodeOwnerThreadMessage, emptySitrepOwnerData, ownerDataFromPreparedBundle, ownerThreadResponseKey, validatePreparedOwnerArchive, validateState, type PreparedRecipient, type PreparedSitrepImportBundle, type SitrepOwnerData } from "@tinyboilerplate/core/feed/sitrep";
import { privateFeedDatabase, parseOwnerJSON } from "./privateFeedDatabase";
import type { HomeHistoricalCommand, HomeThreadRoute } from "./feedStoreTypes";

export const OWNER_IMPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS feed_owner_imports (
  source_space_id TEXT NOT NULL, namespace TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  bundle_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(source_space_id,namespace,snapshot_id)
)`;
function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T { if (!result.ok) throw new Error(result.error?.message ?? "Owner archive storage failed"); return result.data as T; }
export const ownerCardKey = (sourceId: string, card: { cardId: string; revision: number; issuanceId: string }): string => JSON.stringify([sourceId, card.cardId, card.revision, card.issuanceId]);
export interface OwnerRecipientRoute { recipients: PreparedRecipient[]; unresolved: string[]; receiptRecipients: PreparedRecipient[] }
export interface OwnerArchiveMember { sourceId: string; identity: { cardId: string; revision: number; issuanceId: string } }
export interface OwnerArchiveProjection {
  owners: Map<string, SitrepOwnerData>;
  routes: Map<string, OwnerRecipientRoute>;
  scopes: Map<string, string>;
  members: Map<string, OwnerArchiveMember[]>;
  retired: Set<string>;
  historicalCommands: Map<string, HomeHistoricalCommand[]>;
  threadRoutes: Map<string, Record<string, HomeThreadRoute>>;
}

/** Plain insert, immutable replay. A colliding archive is never replaced. */
export async function archivePreparedOwnerBundle(database: FeedDatabase, value: unknown): Promise<void> {
  database = privateFeedDatabase(database);
  const bundle = await validatePreparedOwnerArchive(value);
  const identity = [bundle.source.spaceId, bundle.source.namespace, bundle.source.snapshotId];
  const bytes = JSON.stringify(value);
  const existing = unwrap(await database.query<string>("SELECT bundle_json FROM feed_owner_imports WHERE source_space_id=? AND namespace=? AND snapshot_id=?", identity)).rows;
  if (existing.length) { if (existing[0]?.[0] !== bytes) throw new Error("Frozen owner archive ID already identifies different bytes"); return; }
  if (bundle.source.previousSnapshotId) {
    const predecessor = unwrap(await database.query("SELECT snapshot_id FROM feed_owner_imports WHERE source_space_id=? AND namespace=? AND snapshot_id=?", [bundle.source.spaceId, bundle.source.namespace, bundle.source.previousSnapshotId]));
    if (!predecessor.rows.length) throw new Error("Frozen owner archive predecessor is missing");
  }
  try {
    unwrap(await database.execute("INSERT INTO feed_owner_imports (source_space_id,namespace,snapshot_id,bundle_json,created_at) VALUES (?,?,?,?,?)", [...identity, bytes, new Date().toISOString()]));
  } catch (error) {
    const replay = unwrap(await database.query<string>("SELECT bundle_json FROM feed_owner_imports WHERE source_space_id=? AND namespace=? AND snapshot_id=?", identity)).rows;
    if (replay[0]?.[0] !== bytes) throw error;
  }
  const saved = unwrap(await database.query<string>("SELECT bundle_json FROM feed_owner_imports WHERE source_space_id=? AND namespace=? AND snapshot_id=?", identity)).rows;
  if (saved[0]?.[0] !== bytes) throw new Error("Frozen owner archive readback did not match");
}

interface CachedArchive {
  stamp: string;
  source: PreparedSitrepImportBundle["source"];
  publishers: PreparedSitrepImportBundle["publishers"];
  cards: Pick<PreparedSitrepImportBundle["cards"][number], "sourceKey" | "publisherId" | "identity" | "record">[];
  routes: PreparedSitrepImportBundle["routes"];
  recipients: PreparedSitrepImportBundle["recipients"];
  deletions: PreparedSitrepImportBundle["deletions"];
  owner: SitrepOwnerData;
  commands: (HomeHistoricalCommand & { publisherId: string; identity: FeedCardIdentity })[];
  messages: { publisherId: string; identity: FeedCardIdentity; messageKey: string; recipientKeys: string[]; unresolved: string[] }[];
}

function retainHistory<T>(before: readonly T[] | undefined, current: readonly T[] | undefined, key: (value: T) => string, immutable?: (value: T) => unknown): T[] {
  const rows = new Map((before ?? []).map((row) => [key(row), row]));
  for (const row of current ?? []) {
    const prior = rows.get(key(row));
    if (prior !== undefined && JSON.stringify(immutable ? immutable(prior) : prior) !== JSON.stringify(immutable ? immutable(row) : row)) throw new Error("Conflicting immutable owner history");
    rows.set(key(row), row);
  }
  return [...rows.values()];
}

export class OwnerArchiveCache {
  // Keep validated semantic context, not raw/base64 archives or duplicated payloads.
  private readonly archives = new Map<string, CachedArchive>();
  private previous?: { key: string; projection: OwnerArchiveProjection };
  constructor(private readonly database: FeedDatabase) { this.database = privateFeedDatabase(database); }

  async load(sources: readonly FeedSource[]): Promise<OwnerArchiveProjection> {
    const metadata = unwrap(await this.database.query("SELECT source_space_id,namespace,snapshot_id,created_at,length(bundle_json) FROM feed_owner_imports", [])).rows;
    const projectionKey = JSON.stringify([metadata, sources.map((source) => [source.sourceId, source.agentDid, source.output, source.responses])]);
    if (this.previous?.key === projectionKey) return this.previous.projection;
    const scopes = new Map<string, Map<string, CachedArchive>>();
    const present = new Set<string>();
    for (const row of metadata) {
      const [spaceId, namespace, snapshotId, createdAt, length] = row as unknown[];
      if (![spaceId, namespace, snapshotId, createdAt].every((value) => typeof value === "string") || typeof length !== "number") throw new Error("Invalid owner archive identity metadata");
      const key = JSON.stringify([spaceId, namespace, snapshotId]); present.add(key);
      const stamp = JSON.stringify([createdAt, length]);
      let cached = this.archives.get(key);
      if (cached && cached.stamp !== stamp) throw new Error("An immutable owner archive was changed");
      if (!cached) {
        const rows = unwrap(await this.database.query("SELECT bundle_json FROM feed_owner_imports WHERE source_space_id=? AND namespace=? AND snapshot_id=?", [String(spaceId), String(namespace), String(snapshotId)])).rows;
        const json = rows[0]?.[0]; if (typeof json !== "string") throw new Error("Owner archive disappeared during validation");
        const bundle = await validatePreparedOwnerArchive(parseOwnerJSON(json, "Invalid frozen owner archive JSON"));
        if (bundle.source.spaceId !== spaceId || bundle.source.namespace !== namespace || bundle.source.snapshotId !== snapshotId) throw new Error("Archive source does not match its owner database key");
        const commands: CachedArchive["commands"] = [];
        const messages: CachedArchive["messages"] = [];
        for (const event of bundle.ownerResponses) {
          const identity = { cardId: event.response.cardId, revision: event.response.revision, issuanceId: event.response.issuanceId };
          if (event.ownerEventKind === "state") {
            const parsed = validateState(event.payload?.data);
            if (!parsed.ok) throw new Error("Invalid archived owner command");
            commands.push({ publisherId: event.publisherId, identity, responseId: event.response.responseId, sourceKey: event.sourceKey, eventKey: event.eventKey, state: parsed.value });
          } else if (event.ownerEventKind === "thread") {
            const decoded = decodeOwnerThreadMessage(event.card, event.payload?.data);
            messages.push({ publisherId: event.publisherId, identity, messageKey: ownerThreadResponseKey(decoded.message), recipientKeys: event.recipientKeys, unresolved: event.unresolvedRecipients });
          }
        }
        cached = { stamp, source: bundle.source, publishers: bundle.publishers, cards: bundle.cards.map(({ sourceKey, publisherId, identity, record }) => ({ sourceKey, publisherId, identity, record })), routes: bundle.routes, recipients: bundle.recipients, deletions: bundle.deletions, owner: ownerDataFromPreparedBundle(bundle), commands, messages };
        this.archives.set(key, cached);
      }
      const scopeKey = JSON.stringify([spaceId, namespace]);
      const scope = scopes.get(scopeKey) ?? new Map<string, CachedArchive>();
      scope.set(String(snapshotId), cached); scopes.set(scopeKey, scope);
    }
    for (const key of this.archives.keys()) if (!present.has(key)) throw new Error("An immutable owner archive is missing");
    const result: OwnerArchiveProjection = { owners: new Map(), routes: new Map(), scopes: new Map(), members: new Map(), retired: new Set(), historicalCommands: new Map(), threadRoutes: new Map() };
    const identityOrigins = new Map<string, string>();
    for (const [scopeKey, snapshots] of scopes) {
      const parents = new Set<string>();
      for (const snapshot of snapshots.values()) {
        const parent = snapshot.source.previousSnapshotId;
        if (parent) { if (!snapshots.has(parent)) throw new Error("Frozen owner archive predecessor is missing"); parents.add(parent); }
      }
      const heads = [...snapshots.values()].filter((snapshot) => !parents.has(snapshot.source.snapshotId));
      if (heads.length !== 1) throw new Error("Frozen owner archive has no unique causal head");
      const chain: CachedArchive[] = []; const visited = new Set<string>();
      let current: CachedArchive | undefined = heads[0];
      while (current) {
        if (visited.has(current.source.snapshotId)) throw new Error("Frozen owner archive causal head contains a cycle");
        visited.add(current.source.snapshotId); chain.push(current);
        current = current.source.previousSnapshotId ? snapshots.get(current.source.previousSnapshotId) : undefined;
      }
      if (visited.size !== snapshots.size) throw new Error("Frozen owner archive has an unrelated causal head");
      const historicalOrigins: NonNullable<SitrepOwnerData["responseOrigins"]> = {};
      for (const snapshot of chain.reverse()) {
        const { owner } = snapshot;
        Object.assign(historicalOrigins, owner.responseOrigins);
        const publishers = new Map(snapshot.publishers.map((publisher) => {
          const actual = sources.find((source) => source.sourceId === publisher.agentId);
          if (actual && (actual.agentDid !== publisher.agentDid || actual.output.database !== publisher.outputResource || actual.responses.database !== publisher.responseResource)) throw new Error("Archived publisher does not match the actual registered grant mapping");
          return [publisher.publisherId, actual] as const;
        }));
        const modelScope = JSON.stringify([snapshot.source.spaceId, snapshot.source.namespace, snapshot.source.snapshotId]);
        const members: OwnerArchiveMember[] = [];
        for (const card of snapshot.cards) {
          const actual = publishers.get(card.publisherId); if (!actual) continue;
          const key = ownerCardKey(actual.sourceId, card.identity);
          if (identityOrigins.has(key) && identityOrigins.get(key) !== scopeKey) throw new Error("Different source origins bind one canonical card identity");
          identityOrigins.set(key, scopeKey);
          const context = emptySitrepOwnerData();
          const previous = result.owners.get(key);
          context.answers = retainHistory(previous?.answers, owner.answers.filter((answer) => answer.card.kind === card.record.kind && answer.card.id === card.record.id), (answer) => answer.sourceKey);
          context.states = owner.states.filter((state) => state.kind === card.record.kind && state.id === card.record.id);
          context.claimDecisions = retainHistory(previous?.claimDecisions, owner.claimDecisions.filter((decision) => decision.card.kind === card.record.kind && decision.card.id === card.record.id), (decision) => decision.sourceKey);
          context.threads = retainHistory(previous?.threads, owner.threads.filter((message) => message.kind === card.record.kind && message.id === card.record.id), (message) => JSON.stringify([message.kind, message.id, message.side, message.messageId]));
          context.deliveries = [...new Map([...(previous?.deliveries ?? []), ...owner.deliveries.filter((delivery) => delivery.publisherId === card.publisherId && delivery.identity.cardId === card.identity.cardId && delivery.identity.revision === card.identity.revision && delivery.identity.issuanceId === card.identity.issuanceId)].map((delivery) => [JSON.stringify(delivery), delivery])).values()];
          context.outboundNotes = retainHistory(previous?.outboundNotes, owner.outboundNotes?.filter((note) => note.card.kind === card.record.kind && note.card.id === card.record.id), (note) => note.responseId, (note) => [note.type, note.sourceKey, note.eventKey, note.responseId, note.card, note.at, note.text]);
          context.groupPriority = owner.groupPriority; context.threadResponses = { ...previous?.threadResponses, ...owner.threadResponses }; context.responseOrigins = { ...historicalOrigins }; context.threadOrigins = { ...previous?.threadOrigins, ...owner.threadOrigins };
          const sameCard = (event: { publisherId: string; identity: FeedCardIdentity }) => event.publisherId === card.publisherId && event.identity.cardId === card.identity.cardId && event.identity.revision === card.identity.revision && event.identity.issuanceId === card.identity.issuanceId;
          const commands = snapshot.commands.filter(sameCard).map((command) => ({ responseId: command.responseId, sourceKey: command.sourceKey, eventKey: command.eventKey, state: command.state }));
          result.historicalCommands.set(key, retainHistory(result.historicalCommands.get(key), commands, (command) => command.responseId));
          const messageRoutes = { ...result.threadRoutes.get(key) };
          for (const message of snapshot.messages.filter(sameCard)) {
            const unresolved = [...message.unresolved];
            const targets = message.recipientKeys.flatMap((recipientKey) => {
              const recipient = snapshot.recipients.find((item) => item.recipientKey === recipientKey);
              if (!recipient?.runtimeTarget) { unresolved.push(recipient?.legacyName ?? recipientKey); return []; }
              return [{ recipientKey, agentId: recipient.runtimeTarget.agentId, ...(recipient.runtimeTarget.provider ? { provider: recipient.runtimeTarget.provider } : {}) }];
            });
            messageRoutes[message.messageKey] = unresolved.length || !targets.length ? { kind: "held", unresolved: [...new Set(unresolved)] } : { kind: "recipients", delivery: { version: 1, targets } };
          }
          result.threadRoutes.set(key, messageRoutes);
          result.owners.set(key, context); result.scopes.set(key, modelScope); result.retired.delete(key);
          members.push({ sourceId: actual.sourceId, identity: card.identity });
          const route = snapshot.routes.find((route) => route.sourceKey === card.sourceKey);
          const recipients = route?.recipientKeys.flatMap((recipientKey) => { const recipient = snapshot.recipients.find((item) => item.recipientKey === recipientKey); return recipient ? [recipient] : []; }) ?? [];
          const fallback = route?.fallbackRecipientKeys.flatMap((recipientKey) => { const recipient = snapshot.recipients.find((item) => item.recipientKey === recipientKey); return recipient ? [recipient] : []; }) ?? [];
          result.routes.set(key, { recipients, receiptRecipients: [...new Map([...recipients, ...fallback].map((recipient) => [recipient.recipientKey, recipient])).values()], unresolved: [...new Set([...(route?.unresolvedRecipients ?? []), ...recipients.filter((recipient) => !recipient.runtimeTarget).map((recipient) => recipient.legacyName)])] });
        }
        result.members.set(modelScope, members);
      }
      for (const deletion of heads[0]!.deletions) if (deletion.classification === "card") {
        for (const snapshot of chain) for (const card of snapshot.cards) if (card.sourceKey === deletion.sourceKey) {
          const publisher = snapshot.publishers.find((publisher) => publisher.publisherId === card.publisherId);
          if (publisher) result.retired.add(ownerCardKey(publisher.agentId, card.identity));
        }
      }
    }
    this.previous = { key: projectionKey, projection: result };
    return result;
  }
}
