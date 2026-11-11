import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  restore?.(); restore = undefined;
});

function card(cardId: string, title: string): HomeFeedEntry {
  return {
    source: { sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" } },
    state: { card: { cardId, revision: 1, issuanceId: "i1", kind: "progress", needsResponse: true, title, body: "Body", urgency: 1, createdAt: "2026-10-28T12:00:00Z" },
      response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: "i1" },
  };
}
const snapshot = (entries: HomeFeedEntry[]): HomeFeedSnapshot => ({ entries, settings: { defaultSelector: "both" } });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={source} homeSite /></MemoryRouter>));
  await act(async () => {});
  return host;
}

function source(network: Promise<HomeFeedSnapshot>, local: HomeFeedSnapshot | null): HomeFeedSource & { subscribed: () => boolean } {
  let subscribed = false;
  return {
    load: () => network,
    cached: async () => local,
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { subscribed = true; return () => {}; },
    subscribed: () => subscribed,
  };
}

test("the device's last feed renders while the network has not answered", async () => {
  const network = deferred<HomeFeedSnapshot>(); // never answers in this test
  const host = await mount(source(network.promise, snapshot([card("c1", "Saved on this device")])));
  expect(host.textContent).toContain("Saved on this device");
  expect(host.textContent).not.toContain("Loading your feed");
});

test("the network answer replaces the device copy, and a late local read never overwrites it", async () => {
  const network = deferred<HomeFeedSnapshot>();
  const local = deferred<HomeFeedSnapshot | null>();
  const feed = source(network.promise, null);
  feed.cached = () => local.promise;
  const host = await mount(feed);
  expect(host.querySelector('ul[aria-label="Loading your feed"]')).not.toBeNull();

  await act(async () => network.resolve(snapshot([card("c2", "Fresh from the node")])));
  await act(async () => local.resolve(snapshot([card("c1", "Saved on this device")])));
  expect(host.textContent).toContain("Fresh from the node");
  expect(host.textContent).not.toContain("Saved on this device");
  expect(feed.subscribed()).toBe(true);
});
