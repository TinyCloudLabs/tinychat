// A post's answers (PostPage.tsx): the page a post card carries, what its owner answered, how that goes to the
// agent, and the unsent progress the device keeps between opens.
import type { FeedResponsePayload } from "@tinycloud/sdk-services/feed";

import { HELD_ANSWER_TTL_MS } from "./answerOutbox";
import type { HomeFeedEntry } from "./feedStoreTypes";

export interface LabPageMedia { type: "image" | "video"; src: string; caption?: string; poster?: string }
export interface LabPageOption { label: string; description?: string; recommended?: boolean; image?: string }
export interface LabPageQuestion { id: string; header?: string; question: string; media?: LabPageMedia[]; options?: LabPageOption[]; multi?: boolean; notePrompt?: string }
/** The page behind a post: its image in the feed, and its questions. The card's body is the page's opening words. */
export interface LabPage { image: string; imageAlt: string; questions: LabPageQuestion[] }
/** One question's answer: the chosen option labels and a note. */
export interface PageAnswer { choices: string[]; note: string }
export type PageAnswers = Record<string, PageAnswer>;

/** The card's page (`payload.page`), when it has one. */
export function labPageOf(entry: HomeFeedEntry): LabPage | undefined {
  const page = entry.state.card.payload?.page as Partial<LabPage> | undefined;
  return page && typeof page.image === "string" && Array.isArray(page.questions) ? page as LabPage : undefined;
}

export const EMPTY_ANSWER: PageAnswer = { choices: [], note: "" };
export const isAnswered = (answer?: PageAnswer) => !!answer && (answer.choices.length > 0 || !!answer.note.trim());
export const answeredCount = (page: LabPage, answers: PageAnswers) => page.questions.filter((question) => isAnswered(answers[question.id])).length;

/** What the agent reads: each answered question, its choices and note, one per line. */
export function pageSummary(page: LabPage, answers: PageAnswers): string {
  return page.questions.flatMap((question) => {
    const answer = answers[question.id];
    if (!isAnswered(answer)) return [];
    const parts = [answer!.choices.join(", "), answer!.note.trim()].filter(Boolean);
    return [`${question.header ?? question.question}: ${parts.join(". ")}`];
  }).join("\n");
}

/** The private payload type of a post's answer. */
export const PAGE_ANSWER_TYPE = "feed.page";

/**
 * The answers as the agent's program reads them, beside the summary in the response's text:
 * `{ answers: { [questionId]: { choices, note? } } }`, only the answered questions, in page order.
 */
export function pageAnswerPayload(page: LabPage, answers: PageAnswers): FeedResponsePayload {
  const data: Record<string, { choices: string[]; note?: string }> = {};
  for (const question of page.questions) {
    const answer = answers[question.id];
    if (!isAnswered(answer)) continue;
    const note = answer!.note.trim();
    data[question.id] = { choices: [...answer!.choices], ...(note ? { note } : {}) };
  }
  return { type: PAGE_ANSWER_TYPE, version: 1, data: { answers: data } };
}

/**
 * Answers for this page, kept to what it still asks: questions it no longer has, and choices it
 * no longer offers, are dropped (an agent's later revision may change the page).
 */
function fitAnswers(page: LabPage, value: unknown): PageAnswers {
  const answers: PageAnswers = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return answers;
  const given = value as Record<string, unknown>;
  for (const question of page.questions) {
    const raw = given[question.id] as { choices?: unknown; note?: unknown } | undefined;
    if (!raw || typeof raw !== "object") continue;
    const offered = question.options?.map((option) => option.label) ?? [];
    const choices = Array.isArray(raw.choices) ? raw.choices.filter((choice): choice is string => typeof choice === "string" && offered.includes(choice)) : [];
    const answer = { choices: question.multi ? choices : choices.slice(0, 1), note: typeof raw.note === "string" ? raw.note : "" };
    if (isAnswered(answer)) answers[question.id] = answer;
  }
  return answers;
}

/** Payloads this tab wrote, until a reload reads them back from the feed (`responsePayloads`). */
const written = new Map<string, FeedResponsePayload>();
export function rememberPageAnswer(responseId: string, payload: FeedResponsePayload): void { written.set(responseId, payload); }

/** The answers stored with the card's saved response, when it is a post answer. */
export function savedPageAnswers(entry: HomeFeedEntry, page: LabPage): PageAnswers | undefined {
  const saved = entry.state.response;
  if (!saved) return undefined;
  const payload = entry.responsePayloads?.[saved.responseId] ?? written.get(saved.responseId);
  if (payload?.type !== PAGE_ANSWER_TYPE || payload.version !== 1) return undefined;
  const data = payload.data as { answers?: unknown } | null;
  return data && typeof data === "object" ? fitAnswers(page, data.answers) : undefined;
}

// The draft: answers tapped on a page and not yet sent, kept on the device like the answer outbox
// (answerOutbox.ts), so leaving the page or closing Home loses none. One key per owner (space) and
// card; a draft follows its card across revisions. Cleared once its answers are sent; one older
// than HELD_ANSWER_TTL_MS is deleted.
const DRAFT_PREFIX = "tinychat.home.post-draft.v1:";
interface StoredDraft { at: string; answers: PageAnswers }

/** The draft's key: the owner's space and the card. */
export function postDraftKey(entry: HomeFeedEntry): string {
  return `${DRAFT_PREFIX}${entry.source.output.spaceId}:${JSON.stringify([entry.source.sourceId, entry.state.card.cardId])}`;
}

function readDraft(key: string, now = Date.now()): StoredDraft | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Partial<StoredDraft> | null;
    const age = value && typeof value.at === "string" ? now - Date.parse(value.at) : NaN;
    if (value && value.answers && typeof value.answers === "object" && age <= HELD_ANSWER_TTL_MS) return value as StoredDraft;
    window.localStorage.removeItem(key);
  } catch { /* Malformed, or storage disabled: no draft. */ }
  return undefined;
}

/** The unsent answers on this card's page, if any. */
export function postDraft(entry: HomeFeedEntry, page: LabPage): PageAnswers | undefined {
  const draft = readDraft(postDraftKey(entry));
  return draft ? fitAnswers(page, draft.answers) : undefined;
}

export function savePostDraft(entry: HomeFeedEntry, answers: PageAnswers): void {
  try { window.localStorage.setItem(postDraftKey(entry), JSON.stringify({ at: new Date().toISOString(), answers } satisfies StoredDraft)); }
  catch { /* localStorage full or disabled: the draft lasts while the page is open. */ }
}

export function clearPostDraft(entry: HomeFeedEntry): void {
  try { window.localStorage.removeItem(postDraftKey(entry)); } catch { /* Nothing to clear. */ }
}

/** Removes every post draft this owner keeps (at sign-out, with the answer outbox). */
export function clearPostDrafts(space: string): void {
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(`${DRAFT_PREFIX}${space}:`));
    for (const key of keys) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}

/**
 * Removes every post draft on this device, whatever space it belongs to: for a sign-out that cannot name its space
 * (a restart that finds a sign-out still pending), so the owner's words do not outlive the account.
 */
export function clearAllPostDrafts(): void {
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => !!key?.startsWith(DRAFT_PREFIX));
    for (const key of keys) storage.removeItem(key);
  } catch { /* Nothing to clear. */ }
}

/**
 * How many post drafts on this device, whatever space they belong to, hold at least one answer and are still within
 * HELD_ANSWER_TTL_MS at `now`. Reads only; a malformed, expired or empty draft is not counted. For the move off
 * tinycloud.chat (originMove.ts), which must not strand them.
 */
export function countPostDrafts(storage: Pick<Storage, "length" | "key" | "getItem">, now = Date.now()): number {
  let drafts = 0;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as Partial<StoredDraft> | null;
      if (!value || typeof value.at !== "string" || !value.answers || typeof value.answers !== "object") continue;
      if (!(now - Date.parse(value.at) <= HELD_ANSWER_TTL_MS)) continue;
      if (Object.values(value.answers).some((answer) => isAnswered(validAnswer(answer)))) drafts++;
    } catch { /* Malformed: not a draft. */ }
  }
  return drafts;
}

function validAnswer(value: unknown): PageAnswer | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { choices, note } = value as Partial<PageAnswer>;
  return Array.isArray(choices) && typeof note === "string" ? { choices, note } : undefined;
}

/** Two sets of answers say the same. */
export function sameAnswers(a: PageAnswers, b: PageAnswers): boolean {
  const keys = (answers: PageAnswers) => Object.keys(answers).filter((id) => isAnswered(answers[id])).sort();
  const ak = keys(a);
  return JSON.stringify(ak) === JSON.stringify(keys(b))
    && ak.every((id) => a[id]!.note.trim() === b[id]!.note.trim() && JSON.stringify(a[id]!.choices) === JSON.stringify(b[id]!.choices));
}

/**
 * Where a post stands, for its card: "Done" once its sent answers cover every question,
 * "1 of 2 answered" while they cover only some, and otherwise what the feed says of any card
 * (`fallback`). Read from the answers stored with the saved response, so it holds after a reload;
 * before anything is sent, from the device's draft. `answered` is the revision that holds the
 * card's answer when only agent replies followed it (as for AnswerForm).
 */
export function postStatus(entry: HomeFeedEntry, page: LabPage, fallback: string, answered?: HomeFeedEntry): string {
  const total = page.questions.length;
  const saved = savedPageAnswers(answered ?? entry, page);
  const count = answeredCount(page, saved ?? postDraft(entry, page) ?? {});
  if (saved && count === total) return "Done";
  return count > 0 && count < total ? `${count} of ${total} answered` : fallback;
}
