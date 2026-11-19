import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { afterFeedFirst, noteScreen, resetLanesForTests } from "@/lib/localFirst/requestLanes";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

// The Feed's side of Feed first (requestLanes.ts): its first network render,
// or a failed first load, releases the startup reads held on a Feed open.

let restore: (() => void) | undefined;
const roots = new Set<Root>();
beforeEach(() => {
  resetLanesForTests();
  noteScreen(true); // this open lands on the Feed
});
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  restore?.(); restore = undefined;
  resetLanesForTests();
});

const empty: HomeFeedSnapshot = { entries: [], settings: { defaultSelector: "both" } };

function source(network: Promise<HomeFeedSnapshot>, local: HomeFeedSnapshot | null = null): HomeFeedSource {
  return {
    load: () => network,
    cached: async () => local,
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
}

async function mount(feed: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={feed} /></MemoryRouter>));
  await act(async () => {});
}

/** A startup read held behind the Feed; `ran` turns true once it is released. */
function heldRead() {
  const read = { ran: false };
  void afterFeedFirst(async () => { read.ran = true; });
  return read;
}

test("the first network render releases held startup reads; the device copy does not", async () => {
  const network = Promise.withResolvers<HomeFeedSnapshot>();
  const read = heldRead();
  await mount(source(network.promise, empty));
  expect(read.ran).toBe(false); // the device copy painted, the network has not answered

  await act(async () => network.resolve(empty));
  expect(read.ran).toBe(true);
});

test("a failed first load releases held startup reads", async () => {
  const network = Promise.withResolvers<HomeFeedSnapshot>();
  const read = heldRead();
  await mount(source(network.promise));
  expect(read.ran).toBe(false);

  await act(async () => network.reject(new Error("node unavailable")));
  expect(read.ran).toBe(true);
});
