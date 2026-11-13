// What an open card draws of its card data, as Shapes (unshown.ts), and so what it does not: the list under
// "Not shown on the card" in Details. A plain card is drawn by HomeFeedEntries/FeedView (the card, its post page, its
// conversation, AgentDetails and CardFacts); a typed card by SitrepCard (its record's shape: unshownSitrep.ts).
// When a renderer starts drawing a field, its shape here must name it, or Details keeps listing it as not shown.
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { briefOf } from "./brief";
import { unshownFields, type Shape, type UnshownField } from "./unshown";
import { sitrepRecordShape } from "./unshownSitrep";

/** Read as facts in Details (Type, Reference) or kept for bookkeeping; never listed. */
const BOOKKEEPING = { cardId: true, revision: true, issuanceId: true, urgency: true, createdAt: true, needsResponse: true, kind: true } as const;

/** A post's page (postAnswers.ts LabPage), as PostPage draws it. */
const PAGE: Shape = {
  image: true, imageAlt: true,
  questions: { "[]": {
    id: true, header: true, question: true, multi: true, notePrompt: true,
    media: { "[]": { type: true, src: true, caption: true, poster: true } },
    options: { "[]": { label: true, description: true, recommended: true, image: true } },
  } },
};

/**
 * A plain card's payload (card guide v2), as the card, its page, its conversation and its Details draw it. A brief or
 * page Home cannot read draws nothing, so all of it is listed.
 */
function plainPayload(payload: Record<string, unknown>): Shape {
  const brief = briefOf(payload);
  const page = payload.page as { image?: unknown; questions?: unknown } | undefined;
  const pageDrawn = typeof page?.image === "string" && Array.isArray(page.questions);
  return {
    summary: true, priority: true, render: true, deadline: true, expiresAt: true, url: true, image: true, body: true,
    agent: { kind: true, model: true, runsOn: true, job: true },
    // Markdown wins when a brief carries both, so a url sent beside it is not drawn. A brief or page Home cannot read
    // is left out of the shape, so it is listed whole.
    ...(brief ? { brief: brief.markdown ? { title: true, markdown: true } : { title: true, url: true } } : {}),
    source: { label: true, url: true, ref: true },
    report: { label: true, url: true },
    ...(pageDrawn ? { page: PAGE } : {}),
    replies: { "[]": { text: true, at: true, replyTo: true } },
  };
}

/**
 * Everything in `card` its open card does not draw. `record`: a typed card's board record, when Home could read it;
 * a typed card it could not read draws none of its payload, so every payload field is listed.
 */
export function cardUnshown(card: FeedCard, typed?: { record?: BoardRecord }): UnshownField[] {
  const payload = card.payload ?? {};
  const payloadShape: Shape = !typed
    ? plainPayload(payload)
    : typed.record
      ? { sitrep: { version: true, record: sitrepRecordShape(typed.record) }, sitrepThread: true, source: { label: true, url: true, ref: true } }
      : {};
  return unshownFields(card, { ...BOOKKEEPING, title: true, body: true, choices: { "[]": { id: true, label: true } }, payload: payloadShape });
}
