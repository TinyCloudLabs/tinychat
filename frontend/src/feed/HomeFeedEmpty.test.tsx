import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { FEED_SKILL_URL } from "./strings";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  restore?.(); restore = undefined;
});

function source(snapshot: HomeFeedSnapshot | "loading"): HomeFeedSource {
  return {
    async load() { return snapshot === "loading" ? new Promise<HomeFeedSnapshot>(() => {}) : structuredClone(snapshot); },
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
}
async function mount(snapshot: HomeFeedSnapshot | "loading") {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={source(snapshot)} /></MemoryRouter>));
  await act(async () => {});
  return host;
}
const empty: HomeFeedSnapshot = { entries: [], settings: { defaultSelector: "needs-action" } };

function card(): HomeFeedEntry {
  return {
    source: { sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" } },
    state: { card: { cardId: "c1", revision: 1, issuanceId: "i1", kind: "progress", needsResponse: false, title: "An update", body: "Body", urgency: 1, createdAt: "2026-10-28T12:00:00Z" },
      response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", cardId: "c1", revision: 1, issuanceId: "i1" },
  };
}

test("a new account on the Home site sees the heading and the No cards yet card, with no view controls", async () => {
  const host = await mount(empty);
  expect(host.querySelector("select")).toBeNull();
});

test("the empty Home offers the agent prompt to copy and the feed guide", async () => {
  const host = await mount(empty);
  const copied: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const copy = host.querySelector("section button");
  expect(copy).toBeDefined();
  await act(async () => (copy as HTMLButtonElement).click());
  expect(copied).toHaveLength(1);
  const how = host.querySelector('a[target="_blank"]');
  expect(host.querySelector('a[href="/chat"]')).not.toBeNull();
  expect(how?.getAttribute("href")).toBe(FEED_SKILL_URL);
});

test("while loading, the control row is in place and three placeholder cards show", async () => {
  const host = await mount("loading");
  // No segment is pressed until the saved view arrives.
  const list = host.querySelector('[aria-busy="true"]');
  expect(list?.querySelectorAll("li")).toHaveLength(3);
});

test("the view controls return once the feed has a card", async () => {
  await mount({ ...empty, entries: [card()] });
});

test("a feed with only past cards keeps Done reachable", async () => {
  await mount({ ...empty, historicalEntries: [card()] });
});
