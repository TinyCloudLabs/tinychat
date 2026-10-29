import { emptySitrepOwnerData, mergeSitrepStates, ownerAnswerLookup, parseSitrepCardPayload, projectSitrepCard, waitingReport, type BoardRecord, type SitrepOwnerData, type SitrepProjection, type WaitingItem } from "@tinyboilerplate/core/feed/sitrep";
import { combineOwnerData } from "./sitrepOwnerStore";
import { homeFeedKey } from "./feedIdentity";
import type { HomeFeedEntry } from "./feedStoreTypes";

export interface TypedCardContext { record: BoardRecord; records: BoardRecord[]; entries: HomeFeedEntry[]; owner: SitrepOwnerData; projection: SitrepProjection; waiting?: WaitingItem }

/** Only registered-source identity or a validated frozen owner archive joins records. */
export function typedContexts(entries: readonly HomeFeedEntry[], fallback: SitrepOwnerData | undefined, now: number): (entry: HomeFeedEntry) => TypedCardContext | undefined {
  const parsed = new Map<string, { entry: HomeFeedEntry; record: BoardRecord }>();
  for (const entry of entries) {
    const payload = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
    if (payload && payload.record.kind === entry.state.card.kind) parsed.set(homeFeedKey(entry), { entry, record: payload.record });
  }
  const all = [...parsed.values()];
  const groups = new Map<string, typeof all>();
  for (const value of all) {
    const key = JSON.stringify([value.entry.source.sourceId, value.entry.modelScope]);
    const subjects = groups.get(key) ?? [];
    subjects.push(value); groups.set(key, subjects);
  }
  const singleSource = new Set(all.map((value) => value.entry.source.sourceId)).size === 1;
  const cache = new Map<string, TypedCardContext>();
  for (const subjects of groups.values()) {
    const subject = subjects[0]; if (!subject) continue;
    const values = all.filter(({ entry }) => entry.source.sourceId === subject.entry.source.sourceId || (subject.entry.modelScope !== undefined && entry.modelScope === subject.entry.modelScope));
    const members = values.map((value) => value.entry);
    const refs = new Map<string, number>();
    for (const { record } of values) { const ref = `${record.kind}:${record.id}`; refs.set(ref, (refs.get(ref) ?? 0) + 1); }
    const records = values.filter(({ record }) => refs.get(`${record.kind}:${record.id}`) === 1).map(({ record }) => record);
    const supplied = members.flatMap((entry) => entry.owner ? [entry.owner] : []);
    const scopeOwner = supplied.length ? combineOwnerData(supplied) : singleSource ? fallback ?? emptySitrepOwnerData() : emptySitrepOwnerData();
    // An information-only ask cannot conceal another card's human request.
    const relationRecords = records.filter((record) => !["ask", "approval"].includes(record.kind) || values.some((value) => value.record === record && value.entry.state.card.needsResponse));
    const waiting = new Map(waitingReport({ records: relationRecords, answers: [], states: scopeOwner.states }, now, ownerAnswerLookup(scopeOwner)).waiting.map((item) => [`${item.kind}:${item.record.id}`, item]));
    for (const { entry, record } of subjects) {
      const base = entry.owner ?? scopeOwner;
      const owner: SitrepOwnerData = {
        ...base,
        answers: [...base.answers, ...scopeOwner.answers.filter((answer) => (answer.card.kind !== record.kind || answer.card.id !== record.id) && refs.get(`${answer.card.kind}:${answer.card.id}`) === 1)],
        states: mergeSitrepStates([...base.states, ...scopeOwner.states.filter((state) => (state.kind !== record.kind || state.id !== record.id) && refs.get(`${state.kind}:${state.id}`) === 1)], "provided"),
        groupPriority: fallback?.groupPriority ?? base.groupPriority ?? scopeOwner.groupPriority,
      };
      const projection = projectSitrepCard(record, relationRecords, owner, now);
      if (!entry.state.card.needsResponse) { projection.request = false; projection.needsAction = false; if (projection.attention === "needs-action") projection.attention = "information"; }
      cache.set(homeFeedKey(entry), { record, records, entries: members, owner, projection, waiting: waiting.get(`${record.kind}:${record.id}`) });
    }
  }
  return (entry) => cache.get(homeFeedKey(entry));
}
