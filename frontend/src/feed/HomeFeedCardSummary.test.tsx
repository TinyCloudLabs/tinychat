import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { HomeFeedEntries } from "./HomeFeedEntries";
import type { HomeFeedEntry, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_CONTEXT, syntheticRecord } from "./sitrep.fixtures";

/**
 * A folded row shows the card's one line: its summary (the board's post) when it has one, else its title. It never falls
 * back to the body or to a question's why-now, which read as a wall of text in the list.
 */
const BODY = "Choose a reversible action, and read all of this long body first.";
function entry(cardId: string, title: string, payload?: Record<string, unknown>): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Test agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: { cardId, revision: 1, issuanceId: "issuance-1", kind: "ask", needsResponse: true, title, body: BODY, urgency: 1, createdAt: "2026-10-28T12:00:00Z", choices: [{ id: "proceed", label: "Proceed" }, { id: "hold", label: "Hold" }], ...(payload ? { payload } : {}) },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: "issuance-1" },
  };
}

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
class QuietObserver {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  MotionGlobalConfig.skipAnimations = false;
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});

async function rowOf(card: HomeFeedEntry): Promise<string> {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = QuietObserver;
  MotionGlobalConfig.skipAnimations = true;
  const feed: HomeFeedSource = {
    load: async () => structuredClone({ entries: [card], settings: { defaultSelector: "both" as const } }),
    async saveResponse() { throw new Error("not used"); },
    async markSeen() {}, async snooze() {}, async setDefaultSelector() {}, subscribe() { return () => {}; },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter><HomeFeedEntries source={feed} /></MemoryRouter>));
  await act(async () => {});
  await act(async () => {});
  const row = host.querySelector('li[data-card-key] button[aria-expanded="false"]');
  expect(row).not.toBeNull();
  return row!.textContent ?? "";
}

test("a card with a summary shows it under the title, and not the body", async () => {
  const text = await rowOf(entry("with-summary", "Ship the node update?", { summary: "Needs your yes on the node update." }));
  expect(text).toContain("Needs your yes on the node update.");
  expect(text).not.toContain("Choose a reversible action");
});

test("a card with no summary shows its title, once, not the body", async () => {
  const text = await rowOf(entry("no-summary", "Ship the node update?"));
  expect(text.split("Ship the node update?")).toHaveLength(2);
  expect(text).not.toContain("Choose a reversible action");
});

test("a question with a why-now but no summary shows its title, not the why-now", async () => {
  const record = syntheticRecord("ask");
  const whyNow = SITREP_CONTEXT.whyNow;
  const text = await rowOf(entry("why-now", "Ship the node update?", { sitrep: { version: 1, record } }));
  expect(text.split("Ship the node update?")).toHaveLength(2);
  expect(text).not.toContain(whyNow);
});
