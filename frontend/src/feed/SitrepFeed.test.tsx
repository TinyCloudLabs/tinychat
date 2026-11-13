import { afterEach, expect, jest, setSystemTime, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { ANSWER_UNDO_SECONDS } from "./AnswerOptions";
import { FeedViewEntries } from "./FeedView";
import type { HomeFeedEntry, HomeFeedMessageDraft, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_CREATED, SITREP_NOW, SITREP_REASKED, syntheticRecord } from "./sitrep.fixtures";
import { foldsInto, parseSitrepCardPayload, type SitrepMessageDelivery } from "@tinyboilerplate/core/feed/sitrep";
import { homeFeedKey } from "./feedIdentity";

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
      if (payload?.type === "sitrep.thread") {
        owner.threads.push(payload.data);
        // As the real loader does: each saved message keeps the route it was sent on.
        const { kind, id, messageId, delivery } = payload.data as { kind: string; id: string; messageId: string; delivery?: SitrepMessageDelivery };
        (entry.threadRoutes ??= {})[JSON.stringify([kind, id, messageId])] = delivery ? { kind: "recipients", delivery } : { kind: "publisher" };
      }
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
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); restore?.(); restore = undefined;
  jest.useRealTimers();
  setSystemTime();
});
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={source} />));
  return { host, async unmount() { await act(async () => root.unmount()); roots.delete(root); host.remove(); } };
}
/** What the card shows before any Details or other closed control is opened. */
function face(host: HTMLElement) {
  const copy = host.cloneNode(true) as HTMLElement;
  for (const node of copy.querySelectorAll("details")) node.remove();
  return copy.textContent ?? "";
}
function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  expect(found !== undefined).toBe(true); return found!;
}
/** An ask's option button: its text starts with the option's label, then its detail. */
function option(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>("fieldset button[aria-pressed]")].find((node) => node.textContent?.startsWith(label));
  expect(found !== undefined).toBe(true); return found!;
}
/** Lets `seconds` of the undo window pass; all of it by default, so a held answer is sent. Needs jest.useFakeTimers(). */
async function wait(seconds = ANSWER_UNDO_SECONDS) {
  await act(async () => { jest.advanceTimersByTime(seconds * 1_000); });
}
async function enter(host: HTMLElement, label: string, text: string) {
  const input = host.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[aria-label="${label}"]`);
  expect(input !== null).toBe(true);
  await act(async () => {
    const prototype = input!.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, text);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function viewSelector(host: HTMLElement, value: string) {
  const selector = host.querySelector<HTMLSelectElement>('select[aria-label="Feed view"]');
  expect(selector !== null).toBe(true);
  await act(async () => { selector!.value = value; selector!.dispatchEvent(new Event("change", { bubbles: true })); });
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
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain(content);
  expect(view.host.querySelector("a[href='https://reports.synthetic-example.ts.net/rehearsal.md']") !== null).toBe(true);
  if (["incident", "ship", "order", "progress"].includes(kind)) expect(view.host.querySelector('textarea[name="answer"]')).toBeNull();
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
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Expired");
  expect(fixture.saved).toEqual([]);
});

test("a reasked question remains actionable when the last imported response belongs to an older asking", async () => {
  const record = { ...syntheticRecord("ask"), lastAskedAt: SITREP_REASKED };
  const fixture = typedFixture(record);
  fixture.owner.answers.push({ sourceKey: "old-answer", card: { kind: "ask", id: record.id }, value: { askId: record.id, action: "answer", choice: "quick", text: "Old owner answer", at: SITREP_CREATED } });
  fixture.entry.state.response = { cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance", responseId: "imported-last", sequence: 999, kind: "answer", text: "Old owner answer", createdAt: SITREP_CREATED };
  const view = await mount(fixture.source);
  await viewSelector(view.host, "needs-action");
  expect(view.host.querySelector('textarea[name="answer"]') !== null).toBe(true);
  expect(view.host.querySelector('[aria-label="Focused card"] [aria-label="Answer steps"]')).toBeNull();
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).not.toContain("Historical owner answer");
});

test("typed code entry never trims invalid whitespace or copies a valid code into the safe response header", async () => {
  const record = { ...syntheticRecord("approval"), approvalType: "openkey", approvalKind: undefined, url: "https://openkey.so/delegate?fixture=synthetic", codeExpected: true };
  delete record.approvalKind;
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
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
  await viewSelector(reopened.host, "needs-action");
  expect(reopened.host.textContent).toContain("Confirm the action is reversible");
  expect(reopened.host.querySelector('[aria-label="Focused card"] [aria-label="Answer steps"]')).toBeNull();
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

test("a note to yourself is offered only inside Ask me later, saved with the reminder, shown when the card comes back, and is not an answer", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  expect(view.host.querySelector('[aria-label="Private note"]')).toBeNull();
  expect(view.host.querySelector('[aria-label="Note to yourself"]')).toBeNull();
  await act(async () => button(view.host, "Ask me later").click());
  expect(view.host.querySelector('[aria-label="Ask me later"]')?.textContent).toContain("Only you see this.");
  await enter(view.host, "Note to yourself", "Check the review first.");
  await act(async () => button(view.host, "Tomorrow morning").click());
  expect(fixture.ownerWrites[0]?.state).toMatchObject({ notes: [expect.objectContaining({ text: "Check the review first." })] });
  expect(fixture.entry.viewEvents).toContainEqual(expect.objectContaining({ kind: "snoozed" }));
  expect(fixture.saved).toEqual([]);
  expect(fixture.owner.answers).toEqual([]);
  await view.unmount();
  const reopened = await mount(fixture.source);
  expect(reopened.host.querySelector('textarea[name="answer"]') !== null).toBe(true);
  // The note is on the card's face when it comes back, not under Details.
  const note = reopened.host.querySelector('[aria-label="Focused card"] [aria-label="Notes to yourself"]');
  expect(note?.textContent).toContain("Your note · only you see it");
  expect(note?.textContent).toContain("Check the review first.");
  expect(reopened.host.querySelector('[aria-label="Card details"]')?.textContent).not.toContain("Check the review first.");
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
  expect(view.host.querySelector('[aria-label="Card thread"] ol')?.textContent).toContain("Existing synthetic owner message");
  expect(view.host.querySelector('[aria-label="Card thread"] details')?.textContent).toContain("Unconfirmed");
  expect(view.host.textContent).toContain("It may arrive twice.");
  expect(fixture.saved).toEqual([]);
  await act(async () => button(view.host, "Send again").click());
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", version: 1, data: { kind: "ask", id: "ask-synthetic", text: "Existing synthetic owner message", resendOf: messageId, delivery: { version: 1, targets: [target] } } });
  expect(fixture.saved[0]?.response.responseId).not.toBe("old-thread-response");
  expect(fixture.owner.answers).toEqual([]);
});

test("an unknown typed record is visibly unsupported and never receives an actionable fallback form", async () => {
  const fixture = typedFixture({ ...syntheticRecord("ask"), kind: "future-kind", title: "Unknown preserved record" });
  const view = await mount(fixture.source);
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Unsupported");
  expect(view.host.querySelector('textarea[name="answer"]')).toBeNull();
  expect(fixture.saved).toEqual([]);
});

test("a proceeding question distinguishes the recommendation, default, and already-proceeded window", async () => {
  const record = { ...syntheticRecord("ask"), mode: "proceeding", recommend: "careful", default: "quick", decideBy: "2000-01-01T00:00:00.000Z", proceededAt: "2000-01-01T00:01:00.000Z" };
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
  const focused = view.host.querySelector('[aria-label="Focused card"]');
  expect(focused?.textContent).toContain("Recommended: Careful option");
  expect(focused?.textContent).toContain("Default: Quick option");
  expect(focused?.textContent).toContain("Already proceeded");
  expect(view.host.querySelector('textarea[name="answer"]') !== null).toBe(true);
  expect(fixture.saved).toEqual([]);
});

test("a folded approval step follows skipOn but becomes needed again after the parent reasks", async () => {
  jest.useFakeTimers();
  const ask = syntheticRecord("ask");
  const fixture = typedFixture(ask);
  const view = await mount(fixture.source);
  const part = { ...syntheticRecord("approval"), id: "folded-secret", title: "Synthetic key requirement", approvalType: "secret", approvalKind: undefined, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=synthetic", forAsk: { id: ask.id, skipOn: ["quick"] } };
  delete part.approvalKind;
  fixture.snapshot.entries.push(typedFixture(part).entry);
  await act(async () => fixture.notify());
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Synthetic key requirement");
  await act(async () => option(view.host, "Quick option").click());
  await wait();
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { askId: ask.id, action: "answer", choice: "quick" } });
  expect(view.host.querySelector('[aria-label="Folded approval step"] button')).toBeNull();
  expect(view.host.querySelector('[aria-label="Focused card"] [aria-label="Answer sent"]')?.textContent).toContain("You chose Quick option");
  ask.lastAskedAt = "2099-01-01T00:00:00.000Z";
  await act(async () => fixture.notify());
  expect(view.host.querySelector('[aria-label="Focused card"] [aria-label="Answer sent"]')).toBeNull();
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain("Synthetic key requirement");
  expect(view.host.querySelector('[aria-label="Folded approval step"] button') !== null).toBe(true);
  expect(view.host.querySelector('textarea[name="answer"]') !== null).toBe(true);
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

test("with no approved link for the owner there is no note-to-owner box: a reply goes only to the posting agent and nothing is held", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture({ ...syntheticRecord("task"), owner: "MissingOfficer" });
  fixture.entry.recipientRoute = { recipients: [], unresolved: ["MissingOfficer"] };
  const view = await mount(fixture.source);
  expect(view.host.querySelector('[aria-label="Note to owner"]')).toBeNull();
  expect(view.host.querySelectorAll("textarea")).toHaveLength(1);
  expect(face(view.host)).not.toContain("unrouted");
  expect(face(view.host)).not.toContain("MissingOfficer");
  await enter(view.host, "Reply to SyntheticOfficer", "Matching names must not pick a destination.");
  await act(async () => button(view.host, "Send").click());
  expect(button(view.host, `Sending to SyntheticOfficer in ${ANSWER_UNDO_SECONDS}s`).disabled).toBe(true);
  await wait();
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.response.kind).toBe("message");
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Matching names must not pick a destination." } });
  expect((fixture.saved[0]?.payload?.data as { delivery?: unknown }).delivery).toBeUndefined();
  expect(fixture.owner.heldNotes).toEqual([]);
  expect(view.host.querySelector('[aria-label="Card details"]')?.textContent).toContain("MissingOfficer has no link you approved");
});

test("held notes saved before stay readable behind a closed Held notes control", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.owner.heldNotes.push({ eventId: "held-one", at: SITREP_CREATED, text: "Keep this held until its recipient is mapped.", intendedRecipient: "UnmappedOwner" });
  const view = await mount(fixture.source);
  const held = [...view.host.querySelectorAll<HTMLDetailsElement>("details")].find((node) => node.querySelector("summary")?.textContent === "Held notes (1)");
  expect(held?.open).toBe(false);
  expect(held?.textContent).toContain("Keep this held until its recipient is mapped.");
  expect(held?.textContent).toContain("Not sent · meant for UnmappedOwner");
});

test("with an approved link the one box replies straight to the card's owner, and its id stays under Details", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture({ ...syntheticRecord("task"), owner: "LinkedOwner" });
  fixture.entry.recipientRoute = { recipients: [{ recipientKey: "approved-officer", legacyName: "LinkedOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" } }], unresolved: [] };
  const view = await mount(fixture.source);
  expect(view.host.querySelectorAll("textarea")).toHaveLength(1);
  // With no messages yet, the conversation is just the box: no list, no delivery details, no stray text.
  const thread = view.host.querySelector('[aria-label="Card thread"]')!;
  expect([...thread.childNodes].map((node) => node.nodeName)).toEqual(["FORM"]);
  expect(face(view.host)).not.toContain("00000000-0000-4000-8000-000000000002");
  expect(view.host.querySelector('[aria-label="Card details"]')?.textContent).toContain("00000000-0000-4000-8000-000000000002");
  await enter(view.host, "Reply to LinkedOwner", "Explicitly send this update.");
  await act(async () => button(view.host, "Send").click());
  await act(async () => button(view.host, "Undo").click());
  await wait(ANSWER_UNDO_SECONDS * 2);
  expect(fixture.saved).toEqual([]);
  await act(async () => button(view.host, "Send").click());
  await wait();
  expect(fixture.saved[0]?.response.kind).toBe("message");
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Explicitly send this update.", delivery: { version: 1, targets: [{ recipientKey: "approved-officer", agentId: "00000000-0000-4000-8000-000000000002", provider: "omp" }] } } });
  expect(fixture.owner.answers).toEqual([]);
  expect(view.host.querySelector('[aria-label="Card thread"] ol')?.textContent).toContain("You to LinkedOwner");
});

test("an open ask has one box, its answer; the reply box takes over once it is answered", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  expect([...view.host.querySelectorAll("textarea")].map((node) => node.name)).toEqual(["answer"]);
  expect(view.host.querySelector('textarea[name="answer"]')?.getAttribute("aria-label")).toBe("Reply to SyntheticOfficer");
  await act(async () => option(view.host, "Careful option").click());
  await wait();
  await act(async () => button(view.host, "Show card").click());
  expect([...view.host.querySelectorAll("textarea")].map((node) => node.name)).toEqual(["reply"]);
});

test("a typed information card cannot manufacture a human question from its extension payload", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.entry.state.card.needsResponse = false;
  const view = await mount(fixture.source);
  await viewSelector(view.host, "information");
  expect(view.host.querySelector('[aria-label="Focused card"]')?.textContent).toContain(String(syntheticRecord("ask").title));
  expect(view.host.querySelector('textarea[name="answer"]') === null).toBe(true);
  expect([...view.host.querySelectorAll("button")].some((button) => button.textContent === "Send answer")).toBe(false);
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
  const parentButton = [...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Cards in this view"] button')].find((button) => button.textContent?.includes(parent.entry.state.card.title));
  expect(parentButton !== undefined).toBe(true);
  await act(async () => parentButton!.click());
  expect(view.host.querySelector('[aria-label="Focused card"] [aria-label="Folded approval step"]') === null).toBe(true);
  expect(view.host.querySelector('[aria-label="Cards in this view"]')?.textContent).toContain(approval.entry.state.card.title);
});

test("a failed card message retains the exact draft until durable saving succeeds", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("task"));
  const send = fixture.source.sendMessage!;
  let fail = true;
  fixture.source.sendMessage = async (...args) => { if (fail) { fail = false; throw new Error("Isolated message write refused"); } return send(...args); };
  const view = await mount(fixture.source);
  await enter(view.host, "Reply to SyntheticOfficer", "Keep this exact draft after the refused write.");
  await act(async () => button(view.host, "Send").click());
  await wait();
  expect(view.host.querySelector<HTMLTextAreaElement>('textarea[name="reply"]')?.value).toBe("Keep this exact draft after the refused write.");
  expect(view.host.querySelector('[aria-label="Card thread"] [role="alert"]')?.textContent).toContain("Isolated message write refused");
  expect(fixture.saved).toEqual([]);
  await act(async () => button(view.host, "Try again").click());
  expect(view.host.querySelector<HTMLTextAreaElement>('textarea[name="reply"]')?.value).toBe("");
  expect(fixture.owner.answers).toEqual([]);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Keep this exact draft after the refused write." } });
});

test("open cards in one named group fold together without losing their separate response identities", async () => {
  const first = typedFixture({ ...syntheticRecord("ask"), group: "Synthetic rollout" });
  const second = typedFixture({ ...syntheticRecord("task"), group: "Synthetic rollout" });
  first.snapshot.entries.push(second.entry);
  const view = await mount(first.source);
  const disclosure = button(view.host, "Synthetic rollout · 2 cards");
  expect(disclosure.getAttribute("aria-expanded")).toBe("false");
  await act(async () => disclosure.click());
  const navigation = view.host.querySelector('[aria-label="Cards in this view"]');
  expect(navigation?.textContent).toContain(first.entry.state.card.title);
  expect(navigation?.textContent).toContain(second.entry.state.card.title);
  const task = [...navigation!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes(second.entry.state.card.title));
  if (!task) throw new Error("Grouped task is not navigable");
  await act(async () => task.click());
  expect(view.host.querySelector('[aria-label="Focused card"] [aria-label="task details"]') !== null).toBe(true);
  expect(first.saved).toEqual([]);
});

test("a proceeding question accepts its actual default instead of silently substituting its recommendation", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture({ ...syntheticRecord("ask"), mode: "proceeding", default: "quick", recommend: "careful", decideBy: "2099-01-01T00:00:00.000Z" });
  const view = await mount(fixture.source);
  expect(view.host.textContent).toContain("Default: Quick option");
  expect(view.host.textContent).toContain("Recommended: Careful option");
  await act(async () => button(view.host, "Fine, go ahead").click());
  expect(option(view.host, "Quick option").getAttribute("aria-pressed")).toBe("true");
  expect(fixture.saved).toEqual([]);
  await wait();
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "accept-default", choice: "quick" } });
});

test("a reply reaches only the linked co-owner; an unlinked one gets nothing and nothing is held for it", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture({ ...syntheticRecord("task"), owner: "SyntheticOwner / MissingOfficer" });
  fixture.entry.recipientRoute = { recipients: [{ recipientKey: "known-owner", legacyName: "SyntheticOwner", runtimeTarget: { agentId: "00000000-0000-4000-8000-000000000001" } }], unresolved: ["MissingOfficer"] };
  const view = await mount(fixture.source);
  expect(view.host.querySelector('[aria-label="Card details"]')?.textContent).toContain("MissingOfficer has no link you approved and does not get it.");
  await enter(view.host, "Reply to SyntheticOwner", "An explicit bounded owner note.");
  await act(async () => button(view.host, "Send").click());
  await wait();
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "An explicit bounded owner note.", delivery: { targets: [{ recipientKey: "known-owner", agentId: "00000000-0000-4000-8000-000000000001" }] } } });
  expect((fixture.saved[0]?.payload?.data as { delivery: { targets: unknown[] } }).delivery.targets).toHaveLength(1);
  expect(fixture.owner.heldNotes).toEqual([]);
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
  const parentButton = [...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Cards in this view"] button')].find((candidate) => candidate.textContent?.includes(parent.entry.state.card.title));
  if (!parentButton) throw new Error("Synthetic parent question is not navigable");
  await act(async () => parentButton.click());
  await enter(view.host, "Approval code", "SYNTHETIC-ORIGINAL-DRAFT");
  const originalInput = view.host.querySelector<HTMLInputElement>('[aria-label="Focused card"] [aria-label="Folded approval step"] [aria-label="Approval code"]');
  if (!originalInput) throw new Error("Folded approval input is missing");
  const replacement = structuredClone(child.entry);
  replacement.state.card = { ...replacement.state.card, revision: 2, issuanceId: "replacement-consent", payload: { sitrep: { version: 1, record: { ...grant, url: "https://openkey.so/delegate?fixture=reissued", issuedAt: SITREP_NOW } } } };
  parent.snapshot.entries = [parent.entry, replacement];
  await act(async () => parent.notify());
  expect(view.host.querySelector('[aria-label="Approval code"]') === originalInput).toBe(true);
  expect(originalInput.value).toBe("SYNTHETIC-ORIGINAL-DRAFT");
  expect(originalInput.disabled).toBe(true);
  expect(view.host.textContent).toContain("Re-issued");
  expect(parent.saved).toEqual([]);
});

test("an officer reply cannot inherit an owner's receipt merely by reusing its message id", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const messageId = "20261029T110000000Z-00000000000000000000000000000001";
  fixture.owner.threads.push(
    { side: "sam", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:00:00.000Z", text: "Original owner message" },
    { side: "officer", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:00:00.000Z", from: "SyntheticOfficer", text: "Separate incoming officer message" },
  );
  const card = fixture.entry.state.card;
  const identity = { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId };
  fixture.entry.responses = [{ ...identity, responseId: "owner-message-response", sequence: 1, kind: "message", createdAt: SITREP_NOW, text: "Card message saved" }];
  fixture.entry.responseHandling = { "owner-message-response": { acknowledgement: { ...identity, responseId: "owner-message-response", handlingId: "owner-message-ack", phase: "acknowledged", createdAt: SITREP_NOW }, outcome: null } };
  Object.assign(fixture.owner, { threadResponses: { [JSON.stringify(["ask", "ask-synthetic", messageId])]: "owner-message-response" } });
  const view = await mount(fixture.source);
  const items = [...view.host.querySelectorAll('[aria-label="Card thread"] li')];
  expect(items.find((item) => item.textContent?.includes("Original owner message"))?.querySelector('[data-step="received"]')?.getAttribute("data-state")).toBe("done");
  expect(items.find((item) => item.textContent?.includes("Separate incoming officer message"))?.querySelector('[aria-label="Answer steps"]')).toBeNull();
  const delivery = [...view.host.querySelectorAll('[aria-label="Message delivery"]')];
  expect(delivery.find((item) => item.textContent?.includes("Original owner message"))?.textContent).toContain("Publisher received");
  expect(delivery.find((item) => item.textContent?.includes("Separate incoming officer message"))?.textContent).not.toContain("Publisher received");
});

test("an unresolved original thread destination is held instead of silently resending to the publisher", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const messageId = "20261029T110100000Z-00000000000000000000000000000003";
  fixture.owner.threads.push({ side: "sam", kind: "ask", id: "ask-synthetic", messageId, at: "2026-10-29T11:01:00.000Z", text: "Keep this original recipient intent." });
  fixture.owner.deliveries.push({ sourceKey: "watch.threads.json", eventSourceKey: `xyz.tinycloud.rocinante/sam/thread/ask/ask-synthetic/${messageId}.json`, publisherId: "legacy", identity: { cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance" }, responseId: "held-thread-response", recipientKey: "unmapped-owner", state: "unconfirmed", routedTo: "owner", dispatch: "never", evidence: "explicit", originalReceipt: { state: "unconfirmed" } });
  fixture.entry.threadRoutes = { [JSON.stringify(["ask", "ask-synthetic", messageId])]: { kind: "held", unresolved: ["UnmappedOwner"] } };
  const view = await mount(fixture.source);
  expect(button(view.host, "Send again").disabled).toBe(true);
  expect(view.host.textContent).toContain("Not sent: UnmappedOwner had no link you approved.");
  await act(async () => button(view.host, "Send again").click());
  expect(fixture.saved).toEqual([]);
});

test("a typed answer shows its steps from its own receipt; one with no transport record stays a historical answer", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const card = fixture.entry.state.card;
  const identity = { cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId };
  fixture.owner.answers.push({ sourceKey: "owner-response/typed-answer", card: { kind: "ask", id: "ask-synthetic" }, value: { askId: "ask-synthetic", action: "answer", choice: "careful", text: "", at: SITREP_NOW } });
  const view = await mount(fixture.source);
  const status = () => view.host.querySelector('[aria-label="Focused card"] [role="status"]');
  const steps = () => [...status()!.querySelectorAll<HTMLElement>('[aria-label="Answer steps"] li')].map((step) => `${step.dataset.step}:${step.dataset.state}`);
  expect(status()?.textContent).toContain("Historical owner answer");
  expect(steps()).toEqual([]);
  Object.assign(fixture.owner, { responseOrigins: { "typed-answer": { sourceKey: "owner-response/typed-answer", eventKey: "owner-response/typed-answer" } } });
  fixture.entry.responses = [{ ...identity, responseId: "typed-answer", sequence: 1, kind: "answer", choiceId: "careful", createdAt: SITREP_NOW, text: "Selected careful" }];
  await act(async () => fixture.notify());
  expect(status()?.textContent).not.toContain("Historical owner answer");
  expect(steps()).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
  fixture.entry.responseHandling = { "typed-answer": { acknowledgement: { ...identity, responseId: "typed-answer", handlingId: "typed-ack", phase: "acknowledged", createdAt: SITREP_NOW }, outcome: { ...identity, responseId: "typed-answer", handlingId: "typed-outcome", phase: "failed", createdAt: SITREP_NOW, detail: { message: "The synthetic step could not run" } } } };
  await act(async () => fixture.notify());
  expect(steps()).toEqual(["sent:done", "received:done", "outcome:failed"]);
  expect(status()?.textContent).toContain("Failed");
  expect(status()?.textContent).toContain("The synthetic step could not run");
});

test("a typed ask is answered with one tap once the undo window runs out, and Undo saves nothing", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  expect(view.host.querySelector('input[type="radio"]')).toBeNull();
  await act(async () => option(view.host, "Careful option").click());
  expect(option(view.host, "Careful option").getAttribute("aria-pressed")).toBe("true");
  expect(option(view.host, "Quick option").disabled).toBe(true);
  expect(button(view.host, "Ask me later").disabled).toBe(true);
  expect(view.host.textContent).toContain(`Sending to SyntheticOfficer in ${ANSWER_UNDO_SECONDS}s`);
  await wait(ANSWER_UNDO_SECONDS - 1);
  await act(async () => button(view.host, "Undo").click());
  expect(option(view.host, "Careful option").getAttribute("aria-pressed")).toBe("false");
  expect(option(view.host, "Quick option").disabled).toBe(false);
  await wait(ANSWER_UNDO_SECONDS * 3);
  expect(fixture.saved).toEqual([]);
  await act(async () => option(view.host, "Careful option").click());
  await wait(ANSWER_UNDO_SECONDS - 1);
  expect(fixture.saved).toEqual([]);
  await wait(1);
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.response).toMatchObject({ kind: "answer", cardId: fixture.entry.state.card.cardId, revision: 1, issuanceId: "synthetic-issuance" });
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", version: 1, data: { askId: "ask-synthetic", action: "answer", choice: "careful", text: "" } });
});

test("a typed answer keeps its own Send, and Accept recommendation and Skip this question wait out the same undo window", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  expect(button(view.host, "Send answer").disabled).toBe(true);
  await act(async () => button(view.host, "Accept recommendation").click());
  expect(option(view.host, "Careful option").getAttribute("aria-pressed")).toBe("true");
  await act(async () => button(view.host, "Undo").click());
  await act(async () => button(view.host, "Skip this question").click());
  expect(button(view.host, `Skipping in ${ANSWER_UNDO_SECONDS}s`).disabled).toBe(true);
  await act(async () => button(view.host, "Undo").click());
  await wait(ANSWER_UNDO_SECONDS * 3);
  expect(fixture.saved).toEqual([]);
  await enter(view.host, "Reply to SyntheticOfficer", "Neither yet: wait for the review.");
  await act(async () => button(view.host, "Send answer").click());
  expect(option(view.host, "Careful option").disabled).toBe(true);
  await wait();
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "answer", text: "Neither yet: wait for the review." } });
  expect((fixture.saved[0]?.payload?.data as { choice?: string }).choice).toBeUndefined();
});

test("a failed typed answer shows its error by the options with Try again, and the retry keeps its response id", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const save = fixture.source.saveResponse;
  const attempts: string[] = [];
  fixture.source.saveResponse = async (entry, response, payload) => {
    attempts.push(response.responseId);
    if (attempts.length === 1) throw new Error("Isolated answer write refused");
    return save(entry, response, payload);
  };
  const view = await mount(fixture.source);
  await act(async () => option(view.host, "Quick option").click());
  await wait();
  const alert = view.host.querySelector('form [role="alert"]');
  expect(alert?.textContent).toContain("Isolated answer write refused");
  expect(view.host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  expect(option(view.host, "Quick option").getAttribute("aria-pressed")).toBe("true");
  expect(fixture.saved).toEqual([]);
  await act(async () => [...alert!.querySelectorAll("button")].find((node) => node.textContent === "Try again")!.click());
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toBe(attempts[0]!);
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "answer", choice: "quick" } });
});

test("an approval stays deliberate: no option to tap, no countdown, and its own button gives the go at once", async () => {
  setSystemTime(new Date(SITREP_NOW));
  const record = syntheticRecord("approval");
  const fixture = typedFixture(record);
  const view = await mount(fixture.source);
  expect(view.host.querySelector("fieldset button[aria-pressed]")).toBeNull();
  expect(view.host.textContent).not.toContain("You can undo it until then");
  await act(async () => button(view.host, "Give the go").click());
  expect([...view.host.querySelectorAll("button")].some((node) => node.textContent === "Undo")).toBe(false);
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { askId: record.id, action: "done", issuedAt: record.issuedAt } });
});

const fold = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Focused card"] [aria-label="Answer sent"]');
const folded = (host: HTMLElement) => host.querySelector<HTMLElement>('[aria-label="Focused card"] article')!.parentElement!.hidden;
/** Holds every later load until `release`, as a slow network would: the saved answer is not yet in the feed. */
function holdLoads(source: HomeFeedSource) {
  const load = source.load;
  const gate = Promise.withResolvers<void>();
  source.load = async (focused) => { await gate.promise; return load(focused); };
  return { release: () => act(async () => gate.resolve()) };
}

test("a typed ask folds to the chosen option's label once sent, and a skipped one says so", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const view = await mount(fixture.source);
  const loads = holdLoads(fixture.source);
  await act(async () => option(view.host, "Careful option").click());
  expect(fold(view.host)).toBeNull();
  await wait();
  expect(fixture.saved).toHaveLength(1);
  expect(fold(view.host)!.textContent).toContain("You chose Careful option");
  expect(folded(view.host)).toBe(true);
  await loads.release();
  expect(fold(view.host)!.textContent).toContain("You chose Careful option");
  expect(fold(view.host)!.textContent).toContain(String(syntheticRecord("ask").title));
  expect(fold(view.host)!.querySelectorAll('[aria-label="Answer steps"] li[data-state="done"]')).toHaveLength(1);
  expect(folded(view.host)).toBe(true);
  await act(async () => button(view.host, "Show card").click());
  expect(folded(view.host)).toBe(false);
  await act(async () => button(view.host, "Add follow-up").click());
  await act(async () => button(view.host, "Skip this question").click());
  await wait();
  expect(fixture.saved[1]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "drop" } });
  expect(fold(view.host)!.textContent).toContain("You skipped this question");
  expect(folded(view.host)).toBe(true);
});

test("an answered ask stays open while one of its approval steps still needs the owner", async () => {
  jest.useFakeTimers();
  const ask = syntheticRecord("ask");
  const fixture = typedFixture(ask);
  const view = await mount(fixture.source);
  const part = { ...syntheticRecord("approval"), id: "folded-secret", title: "Synthetic key requirement", approvalType: "secret", approvalKind: undefined, name: "SYNTHETIC_KEY", url: "https://secrets.tinycloud.xyz/request?fixture=synthetic", forAsk: { id: ask.id, skipOn: ["quick"] } };
  delete part.approvalKind;
  fixture.snapshot.entries.push(typedFixture(part).entry);
  await act(async () => fixture.notify());
  const loads = holdLoads(fixture.source);
  await act(async () => option(view.host, "Careful option").click());
  await wait();
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { action: "answer", choice: "careful" } });
  expect(fold(view.host)).toBeNull();
  await loads.release();
  expect(fold(view.host)).toBeNull();
  expect(folded(view.host)).toBe(false);
  expect(view.host.querySelector('[aria-label="Folded approval step"] button') !== null).toBe(true);
});

test("the folded row keeps the conversation one tap away: its latest line, and a reply that counts down like an answer", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.owner.threads.push({ side: "officer", kind: "ask", id: "ask-synthetic", messageId: "20261029T113000000Z-00000000000000000000000000000030", at: "2026-10-29T11:30:00.000Z", from: "SyntheticOfficer", text: "Both options are ready to run." });
  const view = await mount(fixture.source);
  await act(async () => option(view.host, "Careful option").click());
  await wait();
  const row = fold(view.host)!;
  expect(row.textContent).toContain("Sent to SyntheticOfficer");
  expect(row.querySelector('[aria-label="Latest in the conversation"]')?.textContent).toContain("Both options are ready to run.");
  await act(async () => button(row, "Reply to SyntheticOfficer").click());
  await enter(row, "Reply to SyntheticOfficer", "Go ahead with the careful run.");
  await act(async () => button(row, "Send").click());
  expect(button(row, `Sending to SyntheticOfficer in ${ANSWER_UNDO_SECONDS}s`).disabled).toBe(true);
  await act(async () => button(row, "Undo").click());
  await wait(ANSWER_UNDO_SECONDS * 2);
  expect(fixture.saved).toHaveLength(1);
  await act(async () => button(row, "Send").click());
  await wait();
  expect(fixture.saved[1]?.response.kind).toBe("message");
  expect(fixture.saved[1]?.payload).toMatchObject({ type: "sitrep.thread", data: { text: "Go ahead with the careful run." } });
  expect(fold(view.host)?.querySelector('[aria-label="Latest in the conversation"]')?.textContent).toContain("You to SyntheticOfficer");
  expect(folded(view.host)).toBe(true);
});

test("the card face says who is asking and what it needs in plain words; ids and wiring wait under a closed Details", async () => {
  const fixture = typedFixture(syntheticRecord("task"));
  const view = await mount(fixture.source);
  const card = view.host.querySelector('[aria-label="Focused card"]') as HTMLElement;
  expect(card.querySelector("article [data-status]")?.textContent).toBe("Needs you");
  expect(card.querySelector("article")?.textContent).toContain("SyntheticOfficer");
  for (const wiring of ["did:key:synthetic-publisher", "authenticated publisher", "owner registry", "unrouted", "immutable message", "Owner:", "F-syntheti"]) expect(face(card)).not.toContain(wiring);
  const details = card.querySelector<HTMLDetailsElement>('[aria-label="Card details"]');
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Details");
  expect(details?.textContent).toContain("did:key:synthetic-publisher");
  expect(details?.querySelector('[aria-label="Card reference"]')?.textContent).toContain("F-syntheti");
  expect(details?.textContent).toContain("Agent working on this: SyntheticOwner");
});

test("a typed card from a crew member shows that name as its author and the posting agent as via", async () => {
  const fixture = typedFixture({ ...syntheticRecord("ask"), from: "CrewMember" });
  const view = await mount(fixture.source);
  expect(view.host.querySelector('[aria-label="Focused card"] [data-agent-line]')?.textContent).toBe("CrewMember");
  expect(view.host.querySelector('[aria-label="Focused card"] [data-agent-line] + p')?.textContent).toMatch(/^via SyntheticOfficer · /);
  expect(view.host.querySelector('textarea[name="answer"]')?.getAttribute("aria-label")).toBe("Reply to CrewMember");
});

test("tapping the agent's name opens everything between you and it in time order, with one reply box", async () => {
  jest.useFakeTimers();
  const fixture = typedFixture(syntheticRecord("ask"));
  const message = (side: "sam" | "officer", minute: number, text: string) => ({ side, kind: "ask", id: "ask-synthetic", messageId: `20261029T11${minute}00000Z-${String(minute).padStart(32, "0")}`, at: `2026-10-29T11:${minute}:00.000Z`, text, ...(side === "officer" ? { from: "SyntheticOfficer" } : {}) });
  fixture.owner.answers.push({ sourceKey: "owner-response/a", card: { kind: "ask", id: "ask-synthetic" }, value: { askId: "ask-synthetic", action: "answer", choice: "careful", text: "", at: "2026-10-29T11:10:00.000Z" } });
  fixture.owner.threads.push(message("officer", 30, "Starting the careful run now."), message("sam", 20, "Tell me when it starts."));
  const view = await mount(fixture.source);
  const author = [...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Focused card"] article button')].find((node) => node.textContent === "SyntheticOfficer");
  await act(async () => author!.click());
  expect(author?.getAttribute("aria-expanded")).toBe("true");
  await act(async () => button(view.host, "Open conversation").click());
  const conversation = view.host.querySelector('[aria-label="Conversation with SyntheticOfficer"]');
  expect(view.host.querySelector('[aria-label="Focused card"]')).toBeNull();
  const lines = [...conversation!.querySelectorAll('[aria-label="Everything in time order"] > li')].map((line) => line.textContent);
  expect(lines).toHaveLength(4);
  ["Choose the synthetic approach", "You chose Careful option", "Tell me when it starts.", "Starting the careful run now."].forEach((text, index) => expect(lines[index]).toContain(text));
  expect(conversation!.querySelectorAll("textarea")).toHaveLength(1);
  expect(conversation!.textContent).toContain("About: Choose the synthetic approach");
  await enter(view.host, "Reply to SyntheticOfficer", "Thanks, carry on.");
  await act(async () => button(view.host, "Send").click());
  await wait();
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.thread", data: { kind: "ask", id: "ask-synthetic", text: "Thanks, carry on." } });
  expect(fixture.owner.answers).toHaveLength(1);
  await act(async () => button(view.host, "Agents").click());
  const list = view.host.querySelector('[aria-label="Your agents"]');
  expect(list?.textContent).toContain("SyntheticOfficer");
  expect(list?.textContent).toContain("You: Thanks, carry on.");
  await act(async () => [...list!.querySelectorAll("button")].find((node) => node.textContent?.includes("SyntheticOfficer"))!.click());
  await act(async () => [...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Everything in time order"] button')].find((node) => node.textContent?.includes("Choose the synthetic approach"))!.click());
  expect(view.host.querySelector('[aria-label="Focused card"] h2')?.textContent).toBe("Choose the synthetic approach");
});

test("an agent whose cards take no replies gets no box, and one plain line says so", async () => {
  const fixture = typedFixture({ ...syntheticRecord("ask"), status: "closed" });
  delete fixture.source.sendMessage;
  const view = await mount(fixture.source);
  await viewSelector(view.host, "both");
  expect(view.host.querySelector('textarea[name="reply"]')).toBeNull();
  await act(async () => button(view.host, "Agents").click());
  await act(async () => [...view.host.querySelectorAll<HTMLButtonElement>('[aria-label="Your agents"] button')][0]!.click());
  expect(view.host.querySelector('[aria-label="Conversation with SyntheticOfficer"] textarea')).toBeNull();
  expect(view.host.querySelector('[aria-label="Conversation with SyntheticOfficer"] [role="status"]')?.textContent).toBe("You can’t reply to SyntheticOfficer here: none of its cards takes replies.");
});
