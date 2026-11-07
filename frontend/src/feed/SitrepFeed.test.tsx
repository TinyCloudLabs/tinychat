import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { installFakeClock } from "@/test/fakeClock.fixture";
import type { HomeFeedEntry, HomeFeedMessageDraft, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_CREATED, SITREP_NOW, SITREP_REASKED, syntheticRecord } from "./sitrep.fixtures";
import { foldsInto, parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";
import { homeFeedKey } from "./feedIdentity";

// Radix portals do not attach in this DOM (happy-dom), so the sheet's chrome (BottomSheet / Dialog) is swapped for an
// inline stand-in with the same props. Everything inside it, and every component around it, is the real one; the
// static import of the Home UI must wait until the mock is registered, hence the dynamic import below.
mock.module("../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" aria-label="sheet" {...props.contentProps}><h2>{props.title}</h2><p>{props.description}</p>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { FeedViewEntries } = await import("./FeedView");

type PrivatePayload = { type: string; version: number; data: unknown };
function typedFixture(record: Record<string, unknown>) {
  const owner = { answers: [] as unknown[], states: [] as unknown[], claimDecisions: [] as unknown[], threads: [] as unknown[], deliveries: [] as unknown[], heldNotes: [] as unknown[] };
  const entry: HomeFeedEntry = {
    source: { sourceId: "synthetic-agent-token", agentDid: "did:key:synthetic-publisher", label: "SyntheticOfficer", output: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_synthetic" }, responses: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_synthetic" } },
    state: {
      card: { cardId: `synthetic-${String(record.kind)}-${String(record.id)}`, revision: 1, issuanceId: "synthetic-issuance", kind: String(record.kind), needsResponse: !["incident", "ship", "order", "progress"].includes(String(record.kind)), title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt),
        payload: { sitrep: { version: 1, record } } },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "synthetic-agent-token", cardId: `synthetic-${String(record.kind)}-${String(record.id)}`, revision: 1, issuanceId: "synthetic-issuance" },
  };
  const saved: { response: NewFeedResponse | HomeFeedMessageDraft; payload?: PrivatePayload }[] = [];
  const ownerWrites: { eventId: string; state: unknown }[] = [];
  const snapshot: HomeFeedSnapshot = { entries: [entry], settings: { defaultSelector: "both" } };
  const listeners = new Set<() => void>();
  const source: HomeFeedSource = {
    async load(focused) {
      const loaded = structuredClone(snapshot);
      // Raw synthetic owner inputs exercise the real renderer/model boundary.
      Object.assign(loaded, { sitrep: structuredClone(owner), ...(focused ? { focusedEntry: structuredClone(entry) } : {}) });
      return loaded;
    },
    async saveResponse(_entry, response, payload?: PrivatePayload) {
      saved.push(structuredClone({ response, ...(payload ? { payload } : {}) }));
      const value = { ...response, sequence: saved.length };
      entry.state.response = value;
      const card = { kind: record.kind, id: record.id };
      if (payload?.type === "sitrep.answer") owner.answers.push({ sourceKey: `owner-response/${response.responseId}`, card, value: payload.data });
      if (payload?.type === "sitrep.state") throw new Error("Private owner state must not enter the answer outbox");
      if (payload?.type === "sitrep.claim") owner.claimDecisions.push({ sourceKey: `owner-response/${response.responseId}`, card, value: payload.data });
      if (payload?.type === "sitrep.thread") owner.threads.push(payload.data);
      return value;
    },
    async sendMessage(_entry, message, payload?: PrivatePayload) {
      saved.push(structuredClone({ response: message, ...(payload ? { payload } : {}) }));
      const value = { ...message, sequence: saved.length };
      if (payload?.type === "sitrep.thread") owner.threads.push(payload.data);
      if (payload?.type === "sitrep.claim" || payload?.type === "sitrep.answer") throw new Error("A message cannot decide a card");
      return value;
    },
    async saveOwnerState(_entry, event) {
      ownerWrites.push(structuredClone(event));
      owner.states.push(structuredClone(event.state));
    },
    async saveHeldNote(_entry, note) { owner.heldNotes.push(structuredClone(note)); },
    async markSeen() { entry.view.seenAt = SITREP_NOW; },
    async snooze(_entry, until) {
      entry.view.snoozedUntil = until;
      (entry.viewEvents ??= []).push({ sequence: entry.viewEvents.length + 1, kind: "snoozed", createdAt: SITREP_NOW, snoozedUntil: until });
    },
    async setDefaultSelector(selector) { snapshot.settings.defaultSelector = selector; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { entry, owner, ownerWrites, saved, source, snapshot, notify() { for (const listener of listeners) listener(); } };
}

let restore: (() => void) | undefined;
let clock: { restore(): void } | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); clock?.restore(); clock = undefined; restore?.(); restore = undefined;
  setSystemTime();
});
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={source} />));
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
/** Finds a button by its visible text in `scope`; pass `document` for the portaled More sheet. */
function button(scope: ParentNode, label: string) {
  const found = [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  expect(found !== undefined).toBe(true); return found!;
}
async function enter(scope: ParentNode, label: string, text: string) {
  const input = scope.querySelector<HTMLTextAreaElement | HTMLInputElement>(`textarea[aria-label="${label}"], input[aria-label="${label}"]`);
  expect(input !== null).toBe(true);
  await act(async () => {
    const prototype = input!.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Picks a segment of the Show control ("Needs you", "All", "Done"). */
async function show(host: HTMLElement, label: string) {
  const segment = [...host.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Show"] button')].find((node) => node.textContent?.startsWith(label));
  expect(segment !== undefined).toBe(true);
  await act(async () => segment!.click());
  expect(segment!.getAttribute("aria-pressed")).toBe("true");
}
function card(scope: ParentNode, title: string) {
  const found = [...scope.querySelectorAll<HTMLElement>("article")].find((node) => node.getAttribute("aria-label") === title);
  expect(found !== undefined).toBe(true); return found!;
}
/** Expands a card in place by its title. */
async function expand(article: HTMLElement) {
  const toggle = article.querySelector<HTMLButtonElement>("h3 button[aria-expanded]");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggle!.click());
  expect(toggle!.getAttribute("aria-expanded")).toBe("true");
}
function answers(scope: ParentNode) { return scope.querySelector('[role="group"][aria-label="Answers"]'); }
function answeredPanel(scope: ParentNode) { return scope.querySelector('[role="status"][aria-label="Your answer"]'); }
function option(scope: ParentNode, label: string) {
  const found = [...(answers(scope)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((node) => node.textContent?.startsWith(label));
  expect(found !== undefined).toBe(true); return found!;
}
/** Opens the card's More sheet; it is portaled into document.body. */
async function more(article: HTMLElement) {
  await act(async () => button(article, "More").click());
}

const visibleFields = [
  ["ask", "Fast but limited."], ["task", "Verify the isolated result"],
  ["incident", "Only the disposable rehearsal is affected."], ["work", "Resume only after a valid decision"],
  ["ship", "0.0.1-test"], ["order", "Keep every rehearsal action inside its disposable directory."],
  ["claim", "Only the isolated marker action has been demonstrated."], ["hold", "A reversible check is incomplete."],
  ["progress", "Review belongs to the assigned owner."],
] as const;
test.each(visibleFields)("%s retains its type-specific content and private report target", async (kind, content) => {
  const fixture = typedFixture(syntheticRecord(kind));
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await expand(article);
  expect(article.textContent).toContain(content);
  expect(article.querySelector("a[href='https://reports.synthetic-example.ts.net/rehearsal.md']") !== null).toBe(true);
  if (["incident", "ship", "order", "progress"].includes(kind)) {
    expect(view.host.querySelector('textarea[aria-label="Your answer"]')).toBeNull();
    expect(answers(view.host)).toBeNull();
  }
});

test("a go approval has its own exact-issuance action, not a generic answer", async () => {
  setSystemTime(new Date(SITREP_NOW));
  const record = syntheticRecord("approval");
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
  await act(async () => button(view.host, "Give the go").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", version: 1, data: { askId: record.id, action: "done", issuedAt: record.issuedAt } });
  expect(fixture.saved[0]?.response).toMatchObject({ cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance" });
});

test("an expired go cannot be submitted and the earlier issuance is not treated as current", async () => {
  const record = { ...syntheticRecord("approval"), expiresAt: "2000-01-01T00:00:00.000Z" };
  const fixture = typedFixture(record);
  fixture.owner.answers.push({ sourceKey: "legacy-stale-go", card: { kind: "approval", id: record.id }, value: { askId: record.id, action: "done", issuedAt: SITREP_CREATED, text: "", at: SITREP_CREATED } });
  const view = await mount(fixture.source);
  expect(button(view.host, "Give the go").disabled).toBe(true);
  expect(answeredPanel(view.host)).toBeNull();
  expect(fixture.saved).toEqual([]);
});

test("a reasked question remains actionable when the last imported response belongs to an older asking", async () => {
  const record = { ...syntheticRecord("ask"), lastAskedAt: SITREP_REASKED };
  const fixture = typedFixture(record);
  fixture.owner.answers.push({ sourceKey: "old-answer", card: { kind: "ask", id: record.id }, value: { askId: record.id, action: "answer", choice: "quick", text: "Old owner answer", at: SITREP_CREATED } });
  fixture.entry.state.response = { cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance", responseId: "imported-last", sequence: 999, kind: "answer", text: "Old owner answer", createdAt: SITREP_CREATED };
  const view = await mount(fixture.source);
  await show(view.host, "Needs you");
  const article = card(view.host, String(record.title));
  expect(answers(article) !== null).toBe(true);
  expect(answeredPanel(article)).toBeNull();
});

test("typed code entry never trims invalid whitespace or copies a valid code into the safe response header", async () => {
  const record = { ...syntheticRecord("approval"), approvalType: "openkey", approvalKind: undefined, url: "https://openkey.so/delegate?fixture=synthetic", codeExpected: true };
  delete record.approvalKind;
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
  await act(async () => button(view.host, "Got a code? Paste it").click());
  await enter(view.host, "Approval code", " SYNTHETIC-CODE ");
  expect(button(view.host, "Save code").disabled).toBe(true);
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="Approval code"]')?.value).toBe(" SYNTHETIC-CODE ");
  await enter(view.host, "Approval code", "SYNTHETIC-CODE");
  await act(async () => button(view.host, "Save code").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", version: 1, data: { action: "code", text: "SYNTHETIC-CODE", issuedAt: record.issuedAt } });
  expect(JSON.stringify(fixture.saved[0]?.response)).not.toContain("SYNTHETIC-CODE");
  expect(view.host.textContent).not.toContain("SYNTHETIC-CODE");
});

test("a task tick persists as owner state and an incomplete task stays in Needs action after reload", async () => {
  const fixture = typedFixture(syntheticRecord("task"));
  const view = await mount(fixture.source);
  const label = [...view.host.querySelectorAll("label")].find((node) => node.textContent?.includes("Verify the isolated result"));
  const tick = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(tick !== undefined && tick !== null).toBe(true);
  await act(async () => tick!.click());
  expect(fixture.ownerWrites[0]?.state).toMatchObject({ kind: "task", id: "task-synthetic", steps: { verify: expect.any(String) } });
  expect(fixture.saved).toEqual([]);
  expect(fixture.owner.answers).toEqual([]);
  await view.unmount();
  const reopened = await mount(fixture.source);
  await show(reopened.host, "Needs you");
  expect(reopened.host.textContent).toContain("Confirm the action is reversible");
  expect(answeredPanel(reopened.host)).toBeNull();
});

test("a claim decision keeps keep/remove/ignore distinct from an ask answer", async () => {
  const fixture = typedFixture(syntheticRecord("claim"));
  const view = await mount(fixture.source);
  await act(async () => button(view.host, "Keep claim").click());
  expect(fixture.saved[0]?.response.kind).toBe("answer");
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.claim", version: 1, data: { choice: "keep", at: expect.any(String) } });
  expect(fixture.owner.answers).toEqual([]);
  expect(fixture.owner.claimDecisions).toContainEqual(expect.objectContaining({ card: { kind: "claim", id: "T-001" }, value: expect.objectContaining({ choice: "keep" }) }));
});

test("a blocker clear is a request for that hold/reference, not an answered question or implicit lift", async () => {
  const fixture = typedFixture(syntheticRecord("hold"));
  const view = await mount(fixture.source);
  await act(async () => button(view.host, "Mark blocker cleared").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.state", version: 1, data: { kind: "hold", id: "hold-synthetic", clears: [expect.objectContaining({ ref: "task:task-synthetic", id: expect.any(String) })] } });
  expect(fixture.saved[0]?.response.kind).toBe("message");
  expect(fixture.owner.answers).toEqual([]);
  expect(fixture.entry.state.card.payload?.sitrep).toMatchObject({ record: { status: "active" } });
});

test("existing private notes stay read-only under Details and are never sent or turned into answers", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.owner.states.push({ kind: "ask", id: "ask-synthetic", steps: {}, updatedAt: "2026-10-29T11:00:00.000Z", notes: [{ id: "note-1", at: "2026-10-29T11:00:00.000Z", text: "This is an update, not a decision." }] });
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await more(article);
  expect(document.querySelector('[aria-label="Your private notes"]')?.textContent).toContain("This is an update, not a decision.");
  expect(fixture.saved).toEqual([]);
  expect(fixture.ownerWrites).toEqual([]);
  expect(fixture.owner.answers).toEqual([]);
  await show(view.host, "Needs you");
  expect(answers(card(view.host, String(fixture.entry.state.card.title))) !== null).toBe(true);
});

test("unconfirmed thread delivery stays historical until an explicit resend creates a new immutable message", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const messageId = "20261029T110100000Z-00000000000000000000000000000001";
  fixture.owner.threads.push({ side: "sam", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:01:00.000Z", text: "Existing synthetic owner message" });
  fixture.owner.deliveries.push({ sourceKey: "watch.threads.json", eventSourceKey: `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${messageId}.json`, eventKey: `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${messageId}.json`, publisherId: "legacy-synthetic-publisher", identity: { cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance" }, responseId: "old-thread-response", recipientKey: "synthetic-officer-key", recipient: "SyntheticOfficer", state: "unconfirmed", routedTo: "owner", dispatch: "never", dispatchBefore: null, evidence: "explicit", originalReceipt: { state: "unconfirmed" } });
  const target = { recipientKey: "synthetic-officer-key", agentId: "00000000-0000-4000-8000-000000000001" };
  fixture.entry.recipientRoute = { recipients: [{ recipientKey: target.recipientKey, legacyName: "SyntheticOfficer", runtimeTarget: { agentId: target.agentId } }], unresolved: [] };
  fixture.entry.threadRoutes = { [JSON.stringify(["ask", "ask-synthetic", messageId])]: { kind: "recipients", delivery: { version: 1, targets: [target] } } };
  const view = await mount(fixture.source);
  await more(card(view.host, String(fixture.entry.state.card.title)));
  await act(async () => button(document, "Message SyntheticOfficer").click());
  expect(document.body.textContent).toContain("Existing synthetic owner message");
  expect(document.body.textContent).toContain("Unconfirmed");
  expect(fixture.saved).toEqual([]);
  await act(async () => button(document, "Resend message").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", version: 1, data: { kind: "ask", id: "ask-synthetic", text: "Existing synthetic owner message", resendOf: messageId, delivery: { version: 1, targets: [target] } } });
  expect(fixture.saved[0]?.response.responseId).not.toBe("old-thread-response");
  expect(fixture.owner.answers).toEqual([]);
});

test("an unknown typed record is visibly unsupported and never receives an actionable fallback form", async () => {
  const fixture = typedFixture({ ...syntheticRecord("ask"), kind: "future-kind", title: "Unknown preserved record" });
  const view = await mount(fixture.source);
  const article = card(view.host, "Unknown preserved record");
  expect(article.querySelector('[role="status"]') !== null).toBe(true);
  expect(article.querySelector('textarea[aria-label="Your answer"]')).toBeNull();
  expect(answers(article)).toBeNull();
  // Only the title's expand toggle: no answer, note, snooze or More control.
  expect([...article.querySelectorAll("button, input, textarea, select")].map((node) => node.getAttribute("aria-expanded"))).toEqual(["false"]);
  expect(fixture.saved).toEqual([]);
});

test("an already-proceeded question stays answerable but no longer offers to accept its default", async () => {
  const record = { ...syntheticRecord("ask"), mode: "proceeding", recommend: "careful", default: "quick", decideBy: "2000-01-01T00:00:00.000Z", proceededAt: "2000-01-01T00:01:00.000Z" };
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
  const article = card(view.host, String(record.title));
  expect(answers(article) !== null).toBe(true);
  expect([...article.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Fine, go ahead")).toBe(false);
  expect(fixture.saved).toEqual([]);
});

test("a folded approval step follows skipOn but becomes needed again after the parent reasks", async () => {
  const ask = syntheticRecord("ask");
  const fixture = typedFixture(ask);
  const view = await mount(fixture.source);
  const part = { ...syntheticRecord("approval"), id: "folded-secret", title: "Synthetic key requirement", approvalType: "secret", approvalKind: undefined, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=synthetic", forAsk: { id: ask.id, skipOn: ["quick"] } };
  delete part.approvalKind;
  fixture.snapshot.entries.push(typedFixture(part).entry);
  await act(async () => fixture.notify());
  const article = card(view.host, String(ask.title));
  expect(article.querySelector('[aria-label="Folded approval step"]')?.textContent).toContain("Synthetic key requirement");
  const timer = installFakeClock(); clock = timer;
  await act(async () => option(article, "Quick option").click());
  expect(fixture.saved).toEqual([]);
  await timer.advance(5000);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { askId: ask.id, action: "answer", choice: "quick" } });
  expect(view.host.querySelector('[aria-label="Folded approval step"] button')).toBeNull();
  ask.lastAskedAt = "2099-01-01T00:00:00.000Z";
  await act(async () => fixture.notify());
  expect(article.querySelector('[aria-label="Folded approval step"]')?.textContent).toContain("Synthetic key requirement");
  expect(view.host.querySelector('[aria-label="Folded approval step"] button') !== null).toBe(true);
  expect(answers(article) !== null).toBe(true);
});

test("typed snooze presets append owner history without creating an answer", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  await act(async () => button(view.host, "Ask me later").click());
  await act(async () => button(view.host, "Tomorrow morning").click());
  expect(fixture.entry.viewEvents).toContainEqual(expect.objectContaining({ kind: "snoozed", snoozedUntil: expect.any(String), createdAt: SITREP_NOW }));
  expect(fixture.saved).toEqual([]);
  expect(fixture.owner.answers).toEqual([]);
});

test("matching display labels never turn an unresolved owner into an authenticated message destination", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.entry.recipientRoute = { recipients: [], unresolved: ["SyntheticOfficer"] };
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await act(async () => button(article, "Message SyntheticOfficer").click());
  await enter(article, "Card message", "Keep this held until its actual recipient is mapped.");
  await act(async () => button(article, "Send").click());
  expect(fixture.saved).toEqual([]);
  expect(fixture.owner.heldNotes).toContainEqual(expect.objectContaining({ intendedRecipient: "SyntheticOfficer", text: "Keep this held until its actual recipient is mapped." }));
  await view.unmount();
  const reopened = await mount(fixture.source);
  const thread = card(reopened.host, String(fixture.entry.state.card.title)).querySelector('section[aria-label="Card thread"]');
  expect(thread?.textContent).toContain("Keep this held until its actual recipient is mapped.");
  expect(thread?.textContent).toContain("Kept private, not sent: SyntheticOfficer isn't connected yet.");
  expect(fixture.saved).toEqual([]);
});

test("an explicit owner note shows its approved recipients and sends a message without answering", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.entry.recipientRoute = { recipients: [{ recipientKey: "approved-officer", legacyName: "SyntheticOfficer", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" } }], unresolved: [] };
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await more(article);
  expect(document.body.textContent).toContain("00000000-0000-4000-8000-000000000002");
  await act(async () => button(article, "Message SyntheticOfficer").click());
  await enter(article, "Card message", "Explicitly send this update.");
  await act(async () => button(article, "Send").click());
  expect(fixture.saved[0]?.response.kind).toBe("message");
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Explicitly send this update.", delivery: { version: 1, targets: [{ recipientKey: "approved-officer", agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" }] } } });
  expect(fixture.owner.answers).toEqual([]);
  await show(view.host, "Needs you");
  expect(answers(card(view.host, String(fixture.entry.state.card.title))) !== null).toBe(true);
});

test("a typed information card cannot manufacture a human question from its extension payload", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.entry.state.card.needsResponse = false;
  const view = await mount(fixture.source);
  const article = card(view.host, String(syntheticRecord("ask").title));
  expect(view.host.querySelector('textarea[aria-label="Your answer"]') === null).toBe(true);
  expect(answers(view.host)).toBeNull();
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent === "Save answer")).toBe(false);
  await expand(article);
  expect(answers(view.host)).toBeNull();
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent === "Save answer")).toBe(false);
  expect(fixture.saved).toEqual([]);
});

test("matching display authors cannot fold an approval from a different registered source into this question", async () => {
  const parent = typedFixture(syntheticRecord("ask"));
  const part = { ...syntheticRecord("approval"), approvalType: "secret", approvalKind: undefined, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=synthetic", forAsk: { id: "ask-synthetic" } };
  delete part.approvalKind;
  const approval = typedFixture(part);
  const askPayload = parseSitrepCardPayload(parent.entry.state.card.payload?.sitrep);
  const partPayload = parseSitrepCardPayload(approval.entry.state.card.payload?.sitrep);
  if (askPayload?.record.kind !== "ask" || partPayload?.record.kind !== "approval") throw new Error("Invalid synthetic fold fixture");
  expect(foldsInto(partPayload.record, askPayload.record)).toBe(true);
  approval.entry.source = { ...approval.entry.source, sourceId: "other-source", agentDid: "did:key:other-registered-source", output: { ...approval.entry.source.output, database: "xyz.tinycloud.tinychat/feed/feed_output_other" }, responses: { ...approval.entry.source.responses, database: "xyz.tinycloud.tinychat/feed/feed_responses_other" } };
  parent.snapshot.entries.push(approval.entry);
  const view = await mount(parent.source);
  const parentCard = card(view.host, parent.entry.state.card.title);
  await expand(parentCard);
  expect(parentCard.querySelector('[aria-label="Folded approval step"]') === null).toBe(true);
  expect(card(view.host, approval.entry.state.card.title) !== parentCard).toBe(true);
});

test("a failed card message retains the exact draft until durable saving succeeds", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const send = fixture.source.sendMessage!;
  let fail = true;
  fixture.source.sendMessage = async (...args) => { if (fail) { fail = false; throw new Error("Isolated message write refused"); } return send(...args); };
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await act(async () => button(article, "Message SyntheticOfficer").click());
  await enter(article, "Card message", "Keep this exact draft after the refused write.");
  await act(async () => button(article, "Send").click());
  expect(article.querySelector<HTMLInputElement>('[aria-label="Card message"]')?.value).toBe("Keep this exact draft after the refused write.");
  expect(fixture.saved).toEqual([]);
  await act(async () => button(article, "Send").click());
  expect(article.querySelector<HTMLInputElement>('[aria-label="Card message"]')?.value).toBe("");
  expect(fixture.owner.answers).toEqual([]);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Keep this exact draft after the refused write." } });
});

test("open cards in one named group fold together without losing their separate response identities", async () => {
  const first = typedFixture({ ...syntheticRecord("ask"), group: "Synthetic rollout" });
  const second = typedFixture({ ...syntheticRecord("task"), group: "Synthetic rollout" });
  first.snapshot.entries.push(second.entry);
  const view = await mount(first.source);
  const group = view.host.querySelector<HTMLElement>('section[aria-label="Card group Synthetic rollout"]');
  if (!group) throw new Error("Named group is not shown");
  const disclosure = group.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  expect(group.querySelector("article")).toBeNull();
  await act(async () => disclosure.click());
  expect(disclosure.getAttribute("aria-expanded")).toBe("true");
  const ask = card(group, first.entry.state.card.title);
  const task = card(group, second.entry.state.card.title);
  // Each member keeps its own controls: the question its answers, the task its steps.
  expect(answers(ask) !== null).toBe(true);
  expect(answers(task)).toBeNull();
  expect(task.querySelector('input[type="checkbox"]') !== null).toBe(true);
  expect(ask.querySelector('input[type="checkbox"]')).toBeNull();
  expect(first.saved).toEqual([]);
});

test("a proceeding question accepts its actual default instead of silently substituting its recommendation", async () => {
  const fixture = typedFixture({ ...syntheticRecord("ask"), mode: "proceeding", default: "quick", recommend: "careful", decideBy: "2099-01-01T00:00:00.000Z" });
  const view = await mount(fixture.source);
  const timer = installFakeClock(); clock = timer;
  await act(async () => button(view.host, "Fine, go ahead").click());
  expect(fixture.saved).toEqual([]);
  await timer.advance(5000);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "accept-default", choice: "quick" } });
});

test("an explicit owner note discloses only to resolved recipients and retains each unrouted intent privately", async () => {
  const fixture = typedFixture({ ...syntheticRecord("task"), owner: "SyntheticOwner / MissingOfficer" });
  fixture.entry.recipientRoute = { recipients: [{ recipientKey: "known-owner", legacyName: "SyntheticOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000001" } }], unresolved: ["MissingOfficer"] };
  const view = await mount(fixture.source);
  const article = card(view.host, String(fixture.entry.state.card.title));
  await more(article);
  expect(document.body.textContent).toContain("Messages on this card go to: SyntheticOwner · 00000000-0000-4000-8000-000000000001");
  await act(async () => button(article, "Message SyntheticOwner").click());
  await enter(article, "Card message", "An explicit bounded owner note.");
  await act(async () => button(article, "Send").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "An explicit bounded owner note.", delivery: { targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001" }] } } });
  expect(fixture.owner.heldNotes).toContainEqual(expect.objectContaining({ intendedRecipient: "MissingOfficer", text: "An explicit bounded owner note." }));
  expect(article.querySelector('section[aria-label="Card thread"]')?.textContent).toContain("Kept private, not sent: MissingOfficer isn't connected yet.");
  expect(fixture.saved[0]?.response.kind).toBe("message");
});

test("an engaged folded approval keeps its exact code draft and old identity when a newer issuance arrives", async () => {
  const parent = typedFixture(syntheticRecord("ask"));
  const grant: Record<string, unknown> = { ...syntheticRecord("approval"), approvalType: "openkey", codeExpected: true, names: ["SYNTHETIC_KEY"], url: "https://openkey.so/delegate?fixture=synthetic", forAsk: { id: "ask-synthetic" } };
  delete grant.approvalKind;
  const child = typedFixture(grant);
  parent.snapshot.entries.push(child.entry);
  const publishedOldChild = structuredClone(child.entry);
  const load = parent.source.load;
  parent.source.load = async (focused) => {
    const snapshot = await load();
    if (focused) {
      if (homeFeedKey(focused) === homeFeedKey(publishedOldChild)) snapshot.focusedEntry = { ...structuredClone(publishedOldChild), currentIssuance: false };
      else if (homeFeedKey(focused) === homeFeedKey(parent.entry)) snapshot.focusedEntry = structuredClone(parent.entry);
      else throw new Error("Synthetic canonical identity is not stored");
    }
    return snapshot;
  };
  const view = await mount(parent.source);
  const parentCard = card(view.host, parent.entry.state.card.title);
  const step = parentCard.querySelector<HTMLElement>('[aria-label="Folded approval step"]');
  if (!step) throw new Error("Folded approval step is missing");
  // The owner engages the folded step: reveal its code field, focus and tap in it, then type.
  await act(async () => button(step, "Got a code? Paste it").click());
  const originalInput = step.querySelector<HTMLInputElement>('[aria-label="Approval code"]');
  if (!originalInput) throw new Error("Folded approval input is missing");
  await act(async () => { originalInput.focus(); originalInput.click(); });
  await enter(step, "Approval code", "SYNTHETIC-ORIGINAL-DRAFT");
  const replacement = structuredClone(child.entry);
  replacement.state.card = { ...replacement.state.card, revision: 2, issuanceId: "replacement-consent", payload: { sitrep: { version: 1, record: { ...grant, url: "https://openkey.so/delegate?fixture=reissued", issuedAt: SITREP_NOW } } } };
  parent.snapshot.entries = [parent.entry, replacement];
  await act(async () => parent.notify());
  expect(card(view.host, parent.entry.state.card.title).querySelector('[aria-label="Folded approval step"] [aria-label="Approval code"]') === originalInput).toBe(true);
  expect(originalInput.value).toBe("SYNTHETIC-ORIGINAL-DRAFT");
  expect(originalInput.disabled).toBe(true);
  // The successor is reached only by explicit navigation from the old request.
  expect(button(step, "Open the new request").disabled).toBe(false);
  expect(parent.saved).toEqual([]);
});

test("an officer reply cannot inherit an owner's receipt merely by reusing its message id", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const messageId = "20261029T110000000Z-00000000000000000000000000000001";
  fixture.owner.threads.push(
    { side: "sam", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:00:00.000Z", text: "Original owner message" },
    { side: "officer", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:00:00.000Z", from: "SyntheticOfficer", text: "Separate incoming officer message" },
  );
  const posted = fixture.entry.state.card;
  const identity = { cardId: posted.cardId, revision: posted.revision, issuanceId: posted.issuanceId };
  fixture.entry.responses = [{ ...identity, responseId: "owner-message-response", sequence: 1, kind: "message", createdAt: SITREP_NOW, text: "Card message saved" }];
  fixture.entry.responseHandling = { "owner-message-response": { acknowledgement: { ...identity, responseId: "owner-message-response", handlingId: "owner-message-ack", phase: "acknowledged", createdAt: SITREP_NOW }, outcome: null } };
  Object.assign(fixture.owner, { threadResponses: { [JSON.stringify(["ask", "ask-synthetic", messageId])]: "owner-message-response" } });
  const view = await mount(fixture.source);
  const items = [...card(view.host, posted.title).querySelectorAll('[aria-label="Card thread"] li')];
  expect(items.find((item) => item.textContent?.includes("Original owner message"))?.textContent).toContain("SyntheticOfficer got it");
  expect(items.find((item) => item.textContent?.includes("Separate incoming officer message"))?.textContent).not.toContain("got it");
});

test("an unresolved original thread destination is held instead of silently resending to the publisher", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const messageId = "20261029T110100000Z-00000000000000000000000000000003";
  fixture.owner.threads.push({ side: "sam", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:01:00.000Z", text: "Keep this original recipient intent." });
  fixture.owner.deliveries.push({ sourceKey: "watch.threads.json", eventSourceKey: `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${messageId}.json`, publisherId: "legacy", identity: { cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance" }, responseId: "held-thread-response", recipientKey: "unmapped-owner", state: "unconfirmed", routedTo: "owner", dispatch: "never", evidence: "explicit", originalReceipt: { state: "unconfirmed" } });
  fixture.entry.threadRoutes = { [JSON.stringify(["ask", "ask-synthetic", messageId])]: { kind: "held", unresolved: ["UnmappedOwner"] } };
  const view = await mount(fixture.source);
  await more(card(view.host, String(fixture.entry.state.card.title)));
  await act(async () => button(document, "Message SyntheticOfficer").click());
  expect(button(document, "Resend message").disabled).toBe(true);
  expect(document.body.textContent).toContain("UnmappedOwner");
  await act(async () => button(document, "Resend message").click());
  expect(fixture.saved).toEqual([]);
});
