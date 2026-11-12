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

function source(snapshot: HomeFeedSnapshot): HomeFeedSource {
  return {
    async load() { return structuredClone(snapshot); },
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
}
async function mount(snapshot: HomeFeedSnapshot) {
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
const controls = (host: HTMLElement) => ({
  selects: host.querySelectorAll("select").length,
  buttons: [...host.querySelectorAll("button")].map((node) => node.textContent?.trim()),
});

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

test("a new account sees the Home heading and No cards yet, with no view controls", async () => {
  const host = await mount(empty);
  expect(host.querySelector("h1")?.textContent).toBe("Home");
  expect(host.querySelector("main")?.getAttribute("aria-label")).toBe("Home");
  expect(host.textContent).toContain("No cards yet");
  expect(controls(host)).toEqual({ selects: 0, buttons: [] });
});

test("the empty Home offers Open Chat and the feed guide", async () => {
  const host = await mount(empty);
  const chat = [...host.querySelectorAll("a")].find((node) => node.textContent === "Open Chat");
  expect(chat?.getAttribute("href")).toBe("/chat");
  const how = [...host.querySelectorAll("a")].find((node) => node.textContent === "How agents post");
  expect(how?.getAttribute("href")).toBe(FEED_SKILL_URL);
});

test("the view controls return once the feed has a card", async () => {
  const host = await mount({ ...empty, entries: [card()] });
  expect(host.textContent).not.toContain("No cards yet");
  expect(host.querySelector('select[aria-label="Feed view"]')).not.toBeNull();
  expect(controls(host).buttons).toContain("History");
});

test("a feed with only past cards keeps History reachable", async () => {
  const host = await mount({ ...empty, historicalEntries: [card()] });
  expect(controls(host).buttons).toContain("History");
  expect(host.textContent).not.toContain("No cards yet");
});
