import { expect, test } from "bun:test";
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import { formHint, unshownFields } from "./unshown";
import { cardUnshown } from "./unshownCard";

const card = (payload: Record<string, unknown>, extra: Record<string, unknown> = {}): FeedCard => ({
  cardId: "c", revision: 1, issuanceId: "i", kind: "decision", needsResponse: true, title: "Which train?", body: "Two trains.",
  choices: [{ id: "a", label: "08:15 direct" }], urgency: 2, createdAt: "2026-11-13T11:51:00.000Z", payload, ...extra,
} as FeedCard);
const paths = (fields: { path: string }[]) => fields.map((field) => field.path);

test("everything outside the drawn shape is listed by path, nested extras and list items included; empty values are not", () => {
  const fields = unshownFields(
    { title: "t", seat: { coach: "C", seat: 42 }, page: { questions: [{ question: "q", hint: "h" }, { question: "r" }] }, note: "", gone: null, tags: [] },
    { title: true, page: { questions: { "[]": { question: true } } } },
  );
  expect(fields).toEqual([{ path: "seat", value: { coach: "C", seat: 42 } }, { path: "page.questions[0].hint", value: "h" }]);
});

test("a value of another form than the renderer draws is listed whole", () => {
  expect(unshownFields({ page: "a string, not a page" }, { page: { questions: { "[]": true } } })).toEqual([{ path: "page", value: "a string, not a page" }]);
  expect(unshownFields({ replies: { text: "not a list" } }, { replies: { "[]": true } })).toEqual([{ path: "replies", value: { text: "not a list" } }]);
});

test("a plain card lists the payload fields Home does not draw, and nothing it does", () => {
  const drawn = card({ summary: "s", priority: 2, agent: { kind: "codex", model: "m", runsOn: "r", job: "j" }, source: { label: "Rail", url: "https://rail.example", ref: "r1" }, deadline: "2026-11-14T00:00:00.000Z", report: { label: "Report", url: "https://x.example/r" } });
  expect(cardUnshown(drawn)).toEqual([]);
  const extra = card({ summary: "s", cost: "£24.50", seat: { coach: "C" }, agent: { kind: "codex", mood: "busy" } }, { tags: ["travel"] });
  expect(paths(cardUnshown(extra))).toEqual(["payload.cost", "payload.seat", "payload.agent.mood", "tags"]);
});

test("a brief's url sent beside its markdown is listed, since the markdown is what the card opens", () => {
  expect(paths(cardUnshown(card({ brief: { title: "Brief", markdown: "# Why", url: "/briefs/why.md" } })))).toEqual(["payload.brief.url"]);
  expect(cardUnshown(card({ brief: { title: "Brief", url: "/briefs/why.md" } }))).toEqual([]);
});

test("a page Home cannot read is listed whole; a readable page lists only its unknown parts", () => {
  expect(paths(cardUnshown(card({ page: { questions: [{ id: "q", question: "Pick" }] } })))).toEqual(["payload.page"]);
  const page = { image: "/p.png", imageAlt: "A plan", questions: [{ id: "q", question: "Pick", hint: "either", options: [{ label: "A", price: 3 }] }] };
  expect(paths(cardUnshown(card({ page })))).toEqual(["payload.page.questions[0].hint", "payload.page.questions[0].options[0].price"]);
});

test("a typed card Home cannot read lists every payload field", () => {
  const unreadable = card({ sitrep: { version: 9, record: { kind: "mystery" } }, source: { label: "Board" } });
  expect(paths(cardUnshown(unreadable, {}))).toEqual(["payload.sitrep", "payload.source"]);
});

test("each listed value says its form in plain words", () => {
  expect([formHint("x"), formHint(3), formHint(true), formHint({ a: 1 }), formHint({ a: 1, b: 2 }), formHint([1, 2, 3])])
    .toEqual(["text", "number", "yes or no", "1 field", "2 fields", "list of 3"]);
});
