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
async function mount(snapshot: HomeFeedSnapshot | "loading", homeSite: boolean) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={source(snapshot)} homeSite={homeSite} /></MemoryRouter>));
  await act(async () => {});
  return host;
}
const empty: HomeFeedSnapshot = { entries: [], settings: { defaultSelector: "needs-action" } };
const views = (host: HTMLElement) => [...host.querySelectorAll('[role="group"][aria-label="Show"] button')].map((node) => node.textContent?.trim());

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
  const host = await mount(empty, true);
  expect(host.querySelector("h1")?.textContent).toBe("Home");
  expect(host.querySelector("main")?.getAttribute("aria-label")).toBe("Home");
  expect(host.querySelector("h2")?.textContent).toBe("No cards yet");
  expect(views(host)).toEqual([]);
  expect(host.querySelector("select")).toBeNull();
});

test("the empty Home offers the agent prompt to copy and the feed guide", async () => {
  const host = await mount(empty, true);
  const copied: string[] = [];
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
  const copy = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Copy prompt");
  expect(copy).toBeDefined();
  await act(async () => copy!.click());
  expect(copied).toHaveLength(1);
  expect(host.textContent).toContain(copied[0]!);
  const how = [...host.querySelectorAll("a")].find((node) => node.textContent === "How agents post");
  expect(how?.getAttribute("href")).toBe(FEED_SKILL_URL);
});

test("while loading, the control row is in place and three placeholder cards show", async () => {
  const host = await mount("loading", true);
  expect(views(host)).toEqual(["Needs you", "All", "Done"]);
  // No segment is pressed until the saved view arrives.
  expect([...host.querySelectorAll('[role="group"][aria-label="Show"] button')].map((node) => node.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
  const list = host.querySelector('[aria-busy="true"]');
  expect(list?.getAttribute("aria-label")).toBe("Loading your feed");
  expect(list?.querySelectorAll("li")).toHaveLength(3);
});

test("the view controls return once the feed has a card", async () => {
  const host = await mount({ ...empty, entries: [card()] }, true);
  expect(host.textContent).not.toContain("No cards yet");
  expect(views(host)).toEqual(["Needs you0", "All", "Done"]);
});

test("a feed with only past cards keeps Done reachable", async () => {
  const host = await mount({ ...empty, historicalEntries: [card()] }, true);
  expect(views(host)).toContain("Done");
  expect(host.textContent).not.toContain("No cards yet");
});

test("the plain build keeps its feed heading, controls and empty message", async () => {
  const host = await mount(empty, false);
  expect(host.querySelector("h1")?.textContent).toBe("Feed");
  expect(host.querySelector("main")?.getAttribute("aria-label")).toBe("Feed");
  expect(host.textContent).toContain("Nothing needs you right now.");
  expect(host.textContent).not.toContain("No cards yet");
  expect(views(host)).toHaveLength(3);
});
