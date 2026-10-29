import { readFeedResponseHandling, readFeedResponsePayload, type FeedDatabase, type FeedResponse, type FeedResponsePayload } from "@tinycloud/sdk-services/feed";
import { cardGroup, emptySitrepOwnerData, ownerThreadResponseKey, parseSitrepCardPayload, mergeSitrepStates, validateState, type SitrepOwnerData } from "@tinyboilerplate/core/feed/sitrep";
import { addCanonicalOwnerEvent, combineOwnerData } from "./sitrepOwnerStore";
import { ownerCardKey } from "./feedIdentity";
import type { HomeFeedEntry } from "./feedStoreTypes";
import type { OwnerArchiveProjection } from "./sitrepArchiveStore";

const TYPED_PAYLOADS = new Set(["sitrep.answer", "sitrep.claim", "sitrep.state", "sitrep.thread", "sitrep.note", "sitrep.hold-notice"]);
function unwrap<T>(result: { ok: boolean; data?: T; error?: { message?: string } }): T { if (!result.ok) throw new Error(result.error?.message ?? "Typed Home history could not be read"); return result.data as T; }

export class TypedFeedHistory {
  private readonly payloads = new Map<string, Promise<FeedResponsePayload | undefined>>();

  async enrich(entry: HomeFeedEntry, output: FeedDatabase, responses: FeedDatabase, history: readonly FeedResponse[], privateOwners: Record<string, SitrepOwnerData>, archives: OwnerArchiveProjection): Promise<HomeFeedEntry> {
    const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
    if (!typed || typed.record.kind !== entry.state.card.kind) return entry;
    const key = ownerCardKey(entry.source.sourceId, entry.state.card);
    const privateOwner = privateOwners[key];
    if (privateOwner?.states.some((state) => state.kind !== typed.record.kind || state.id !== typed.record.id) || (privateOwner?.groupPriority && Object.keys(privateOwner.groupPriority.groups).some((group) => group !== cardGroup(typed.record)))) throw new Error("Private owner state does not address its canonical typed card");
    const owner = combineOwnerData([archives.owners.get(key) ?? emptySitrepOwnerData(), privateOwner ?? emptySitrepOwnerData()]);
    const relevant = history.filter((response) => response.cardId === entry.state.card.cardId && response.revision === entry.state.card.revision && response.issuanceId === entry.state.card.issuanceId);
    const handling: NonNullable<HomeFeedEntry["responseHandling"]> = {};
    const threadRoutes: NonNullable<HomeFeedEntry["threadRoutes"]> = { ...archives.threadRoutes.get(key) };
    for (const response of relevant) {
      const identityKey = ownerCardKey(entry.source.sourceId, response);
      if (TYPED_PAYLOADS.has(response.payloadType ?? "")) {
        const payloadKey = JSON.stringify([identityKey, response.responseId]);
        let pending = this.payloads.get(payloadKey);
        if (!pending) {
          pending = readFeedResponsePayload(responses, response).then(unwrap).catch((error: unknown) => { this.payloads.delete(payloadKey); throw error; });
          this.payloads.set(payloadKey, pending);
        }
        const payload = await pending;
        if (!payload) throw new Error("Typed response metadata has no durable private payload");
        const decoded = addCanonicalOwnerEvent(owner, entry, response, payload);
        if (decoded) {
          const messageKey = ownerThreadResponseKey(decoded.message);
          if (!Object.hasOwn(threadRoutes, messageKey)) {
            if (!decoded.delivery) threadRoutes[messageKey] = { kind: "publisher" };
            else {
              const approved = archives.routes.get(key)?.receiptRecipients ?? [];
              const unresolved = decoded.delivery.targets.filter((target) => !approved.some((recipient) => recipient.recipientKey === target.recipientKey && recipient.runtimeTarget?.agentId === target.agentId && recipient.runtimeTarget.provider === target.provider)).map((target) => target.recipientKey);
              threadRoutes[messageKey] = unresolved.length ? { kind: "held", unresolved } : { kind: "recipients", delivery: decoded.delivery };
            }
          }
        }
      }
      const receipt = await readFeedResponseHandling(output, response);
      if (receipt.ok) handling[response.responseId] = receipt.data;
      else if (receipt.error.code !== "NOT_FOUND") throw new Error(receipt.error.message);
    }
    owner.states = mergeSitrepStates(owner.states, "provided");
    const previous = owner.states.find((state) => state.kind === typed.record.kind && state.id === typed.record.id);
    const snoozes = [...(previous?.snoozes ?? []), ...(entry.viewEvents ?? []).flatMap((event) => event.kind === "snoozed" && event.snoozedUntil ? [{ at: event.createdAt, until: event.snoozedUntil }] : [])];
    const uniqueSnoozes = [...new Map(snoozes.map((snooze) => [`${snooze.at}:${snooze.until}`, snooze])).values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-20);
    const hasLiveSnooze = entry.viewEvents?.some((event) => event.kind === "snoozed");
    if (previous || entry.view.seenAt || hasLiveSnooze) {
      const state = validateState({ kind: typed.record.kind, id: typed.record.id, steps: {}, ...previous, ...(entry.view.seenAt ? { seenAt: entry.view.seenAt } : {}), ...(hasLiveSnooze ? { snoozedUntil: entry.view.snoozedUntil ?? null } : {}), ...(uniqueSnoozes.length ? { snoozes: uniqueSnoozes } : {}), updatedAt: previous?.updatedAt ?? entry.view.seenAt ?? entry.state.card.createdAt });
      if (!state.ok) throw new Error("Invalid typed owner view history");
      owner.states = [...owner.states.filter((old) => old.kind !== typed.record.kind || old.id !== typed.record.id), state.value];
    }
    const completeOwner = combineOwnerData([owner]);
    return { ...entry, responses: [...relevant], owner: completeOwner, responseHandling: handling, threadRoutes, historicalCommands: archives.historicalCommands.get(key) ?? [], ...(archives.scopes.has(key) ? { modelScope: archives.scopes.get(key) } : {}), ...(archives.routes.has(key) ? { recipientRoute: archives.routes.get(key) } : {}) };
  }
}
