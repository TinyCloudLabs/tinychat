// The open card's sections (Feed, slice 7): what the owner sees in "Known so far", an approval's steps, the expiry
// line, the options' legend, size and "Suggested" mark, the missing second button, who a comment is for, the link chip.
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { installFakeClock } from "@/test/fakeClock.fixture";
import type { NewFeedResponse } from "@tinycloud/sdk-services/feed";
import type { HomeFeedEntry, HomeFeedMessageDraft, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

// Same stand-in for the sheet chrome as SitrepFeed.test.tsx (Radix portals do not attach in this DOM).
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
let rect: typeof HTMLElement.prototype.getBoundingClientRect | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); clock?.restore(); clock = undefined;
  if (rect) HTMLElement.prototype.getBoundingClientRect = rect;
  rect = undefined; restore?.(); restore = undefined;
  setSystemTime();
});
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={source} />));
  // Opens every card in place: a row's button opens it.
  for (let next = row(host); next; next = row(host)) await act(async () => next!.click());
  return host;
}
function row(host: ParentNode) {
  return [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((item) => !item.querySelector("article") && !item.closest("[inert]"))
    .map((item) => item.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')).find(Boolean) ?? null;
}
function article(host: ParentNode) {
  const found = host.querySelector<HTMLElement>("article");
  expect(found).not.toBeNull(); return found!;
}
function button(scope: ParentNode, label: string) {
  const found = [...scope.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);
  expect(found !== undefined).toBe(true); return found!;
}
const fold = (scope: ParentNode, title: string) => [...scope.querySelectorAll("details")].find((node) => node.querySelector("summary")?.textContent?.startsWith(title));
const options = (scope: ParentNode) => scope.querySelector("fieldset")!;
const choice = (scope: ParentNode, label: string) => [...options(scope).querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith(label))!;

test("Known so far stays folded on a wide card (600 px), with its count", async () => {
  restore ??= installDom();
  rect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function wide() { return { x: 0, y: 0, top: 0, left: 0, right: 600, bottom: 100, width: 600, height: 100, toJSON() { return {}; } } as DOMRect; };
  const record = syntheticRecord("ask");
  (record.context as { known: string[] }).known = ["The window opens at 02:00.", "Two builds are ready."];
  const host = await mount(typedFixture(record).source);
  const known = fold(article(host), "Known so far");
  expect(known?.querySelector("summary")?.textContent).toBe("Known so far2 facts");
  expect(known?.open).toBe(false);
});

test("an approval's steps sit in a fold named Steps, with their count, open", async () => {
  const record = { ...syntheticRecord("approval"), steps: ["Check the window", "Tell the team"] };
  const host = await mount(typedFixture(record).source);
  const steps = fold(article(host), "Steps");
  expect(steps?.querySelector("summary")?.textContent).toBe("Steps2 steps");
  expect(steps?.open).toBe(true);
  expect([...steps!.querySelectorAll("ol > li")].map((node) => node.textContent)).toEqual(["Check the window", "Tell the team"]);
});

test("the expiry is its own line under the answers, in UTC", async () => {
  setSystemTime(new Date(SITREP_NOW));
  const record = { ...syntheticRecord("ask"), expiresAt: "2026-11-20T02:33:00.000Z" };
  const host = await mount(typedFixture(record).source);
  const set = options(article(host));
  const line = [...set.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Expires "));
  expect(line?.textContent).toBe("Expires 20 Nov, 02:33 UTC");
  const buttons = [...set.querySelectorAll("button")];
  expect(buttons.at(-1)!.compareDocumentPosition(line!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("the options' legend is for screen readers only", async () => {
  const host = await mount(typedFixture(syntheticRecord("ask")).source);
  const legend = options(article(host)).querySelector("legend");
  expect(legend?.textContent).toBe("Choose an option");
  expect(legend?.classList.contains("sr-only")).toBe(true);
});

test("an answer button is 44 px at least with a 13.5 px label, and Suggested is a small line under it", async () => {
  const host = await mount(typedFixture(syntheticRecord("ask")).source);
  const careful = choice(article(host), "Careful option");
  expect(careful.classList.contains("min-h-11")).toBe(true);
  expect(careful.classList.contains("min-h-14")).toBe(false);
  const [label, suggested, detail] = [...careful.children] as HTMLElement[];
  expect(label?.className).toContain("text-[13.5px]");
  expect(suggested?.textContent).toBe("Suggested");
  expect(suggested?.className).toContain("text-[11px]");
  expect(suggested?.className).not.toContain("border");
  expect(detail?.className).toContain("text-[12.5px]");
  expect(choice(article(host), "Quick option").textContent).not.toContain("Suggested");
});

test("a card with a recommendation has no second Accept button; tapping the suggested option sends that choice after the wait", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  const host = await mount(fixture.source);
  const card = article(host);
  expect([...card.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Accept recommendation")).toBe(false);
  expect(choice(card, "Careful option").textContent).toContain("Suggested");
  const timer = installFakeClock(); clock = timer;
  await act(async () => choice(card, "Careful option").click());
  await timer.advance(5000);
  expect(fixture.saved).toHaveLength(1);
  expect(fixture.saved[0]?.payload).toMatchObject({ type: "sitrep.answer", data: { askId: "ask-synthetic", choice: "careful" } });
});

test("a comment is for the officer the card names, not for the connection it came through", async () => {
  const fixture = typedFixture(syntheticRecord("ask"));
  fixture.entry.source.label = "Ops board";
  const host = await mount(fixture.source);
  const card = article(host);
  expect(button(card, "Leave a comment for SyntheticOfficer")).toBeDefined();
  expect([...card.querySelectorAll("button")].some((node) => node.textContent?.trim() === "Leave a comment for Ops board")).toBe(false);
});

test("the link chip's icon is a bare arrow up and right", async () => {
  const host = await mount(typedFixture(syntheticRecord("ask")).source);
  const chip = article(host).querySelector("a[href='https://reports.synthetic-example.ts.net/rehearsal.md']");
  const icon = chip?.querySelector("svg");
  expect(icon?.getAttribute("class")).toContain("lucide-arrow-up-right");
  expect(icon?.getAttribute("class")).not.toContain("lucide-external-link");
});
