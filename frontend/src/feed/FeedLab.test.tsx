// The feed lab: the real feed on made-up cards, a simulated agent in the real source's shapes, and no trace
// of either in a build without VITE_FEED_LAB.
import { afterEach, describe, expect, jest, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { parseSitrepCardPayload } from "@tinyboilerplate/core/feed/sitrep";
import { FEED_LAB, FEED_LAB_PATH, FeedLabRoutes as lazyRoutes } from "@/lib/feedLab";
import { installDom } from "@/test/dom";
import { ANSWER_UNDO_SECONDS } from "./AnswerOptions";
import FeedLabRoutes from "./FeedLab";
import { createFeedLabSource, LAB_COMPLETED_MS, LAB_OUTCOME, LAB_RECEIVED_MS, LAB_SAVE_MS } from "./feedLabSource";
import type { HomeFeedEntry } from "./feedStoreTypes";

let restore: (() => void) | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  restore?.(); restore = undefined;
});
async function mount(address: string) {
  restore ??= installDom();
  const calls: unknown[] = [];
  globalThis.fetch = (async (...args: unknown[]) => { calls.push(args); return new Response(null, { status: 500 }); }) as typeof fetch;
  window.navigator.sendBeacon = (...args: unknown[]) => { calls.push(args); return true; };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<MemoryRouter initialEntries={[address]}><Routes><Route path="/" element={<p>Signed-out page</p>} /><Route path="*" element={<FeedLabRoutes />} /></Routes></MemoryRouter>));
  return { host, calls };
}
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  expect(node).toBeDefined();
  return node!;
}
const focusedTitle = (host: HTMLElement) => host.querySelector('[aria-label="Focused card"] h2')?.textContent;
function answerTo(entry: HomeFeedEntry, choiceId: string): NewFeedResponse {
  const { cardId, revision, issuanceId } = entry.state.card;
  return { responseId: crypto.randomUUID(), cardId, revision, issuanceId, kind: "answer", choiceId, createdAt: new Date().toISOString() };
}

test("the six made-up cards are two plain questions, a plain update, two typed asks and a typed approval", async () => {
  const { entries } = await createFeedLabSource().load();
  expect(entries).toHaveLength(6);
  const plain = entries.filter((entry) => entry.state.card.payload?.sitrep === undefined);
  expect(plain.filter((entry) => entry.state.card.needsResponse).map((entry) => entry.state.card.choices?.length)).toEqual([2, 3]);
  expect(plain.filter((entry) => !entry.state.card.needsResponse).map((entry) => entry.state.card.choices)).toEqual([undefined]);
  const records = entries.flatMap((entry) => entry.state.card.payload?.sitrep === undefined ? [] : [parseSitrepCardPayload(entry.state.card.payload.sitrep)?.record]);
  expect(records.map((record) => record?.kind)).toEqual(["ask", "ask", "approval"]);
  for (const record of records) {
    if (record?.kind !== "ask") continue;
    expect(record.options.every((option) => !!option.detail)).toBe(true);
    expect(record.options.some((option) => option.id === record.recommend)).toBe(true);
    expect(record.context.background.length).toBeGreaterThan(0);
  }
});

test("the simulated agent receives a saved answer after 1.5 s and completes it after 6 s, as the real source reports it", async () => {
  jest.useFakeTimers();
  const source = createFeedLabSource();
  let changes = 0;
  source.subscribe(() => { changes++; });
  const [question] = (await source.load()).entries;
  const saving = source.saveResponse(question!, answerTo(question!, "direct"));
  jest.advanceTimersByTime(LAB_SAVE_MS);
  const response = await saving;
  expect(response).toMatchObject({ cardId: "lab-train", kind: "answer", choiceId: "direct", sequence: 1 });
  expect((await source.load()).entries[0]!.state).toMatchObject({ response, acknowledgement: null, outcome: null });
  jest.advanceTimersByTime(LAB_RECEIVED_MS);
  expect((await source.load()).entries[0]!.state).toMatchObject({ acknowledgement: { responseId: response.responseId, phase: "acknowledged" }, outcome: null });
  expect(changes).toBe(1);
  jest.advanceTimersByTime(LAB_COMPLETED_MS - LAB_RECEIVED_MS);
  expect((await source.load()).entries[0]!.state.outcome).toMatchObject({ responseId: response.responseId, phase: "succeeded", detail: { message: LAB_OUTCOME } });
  expect(changes).toBe(2);
});

test("a typed answer comes back as the owner's answer with its own receipt, and stop cancels the simulated agent", async () => {
  jest.useFakeTimers();
  const source = createFeedLabSource();
  const ask = (await source.load()).entries.find((entry) => entry.state.card.cardId === "lab-letter")!;
  const at = new Date().toISOString();
  const saving = source.saveResponse(ask, { ...answerTo(ask, "short"), createdAt: at }, { type: "sitrep.answer", version: 1, data: { askId: "newsletter-version", action: "answer", choice: "short", text: "", at } });
  jest.advanceTimersByTime(LAB_SAVE_MS);
  const response = await saving;
  jest.advanceTimersByTime(LAB_RECEIVED_MS);
  const loaded = (await source.load(ask)).focusedEntry!;
  expect(loaded.owner?.answers).toEqual([expect.objectContaining({ card: { kind: "ask", id: "newsletter-version" }, value: expect.objectContaining({ choice: "short" }) })]);
  expect(loaded.responses).toEqual([expect.objectContaining({ responseId: response.responseId, payloadType: "sitrep.answer", text: "Selected short" })]);
  expect(loaded.responseHandling?.[response.responseId]).toMatchObject({ acknowledgement: { phase: "acknowledged" }, outcome: null });
  source.stop();
  jest.advanceTimersByTime(LAB_COMPLETED_MS);
  expect((await source.load(ask)).focusedEntry!.responseHandling?.[response.responseId]?.outcome).toBeNull();
});

test("the lab shows the real feed at its own address, Reset restores the cards, and nothing leaves the page", async () => {
  const { host, calls } = await mount(FEED_LAB_PATH);
  const stored = () => JSON.stringify([{ ...window.localStorage }, { ...window.sessionStorage }]);
  const before = stored();
  expect(host.textContent).toContain("Feed lab");
  expect(host.querySelector('main[aria-label="Feed"]')).not.toBeNull();
  expect(focusedTitle(host)).toBe("Which train should I hold for Friday?");
  await act(async () => button(host, "Snooze for 1 hour").click());
  expect(focusedTitle(host)).toBe("The water filter order renews tomorrow. Keep it?");
  expect(host.querySelector('[aria-label="Cards in this view"]')?.textContent).not.toContain("Which train");
  await act(async () => button(host, "Reset").click());
  expect(focusedTitle(host)).toBe("Which train should I hold for Friday?");
  expect(calls).toEqual([]);
  expect(stored()).toBe(before);
});

test("in the lab an answer runs its whole course: one tap, the undo window, the fold, then the simulated agent ticks the steps", async () => {
  jest.useFakeTimers();
  const { host, calls } = await mount(FEED_LAB_PATH);
  const pass = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  const steps = () => [...host.querySelectorAll<HTMLElement>('[aria-label="Answer sent"] [aria-label="Answer steps"] li')].map((step) => `${step.dataset.step}:${step.dataset.state}`);
  await act(async () => button(host, "08:15 direct").click());
  expect(host.textContent).toContain(`Sending to Trip agent in ${ANSWER_UNDO_SECONDS}s`);
  await pass(ANSWER_UNDO_SECONDS * 1_000);
  expect(host.textContent).toContain("Sending…");
  expect(host.querySelector('[aria-label="Answer sent"]')).toBeNull();
  await pass(LAB_SAVE_MS);
  expect(host.querySelector('[aria-label="Answer sent"]')?.textContent).toContain("You chose 08:15 direct");
  expect(steps()).toEqual(["sent:done", "received:upcoming", "outcome:upcoming"]);
  await pass(LAB_RECEIVED_MS);
  expect(steps()).toEqual(["sent:done", "received:done", "outcome:upcoming"]);
  await pass(LAB_COMPLETED_MS - LAB_RECEIVED_MS);
  expect(steps()).toEqual(["sent:done", "received:done", "outcome:done"]);
  expect(host.querySelector('[aria-label="Answer sent"]')?.textContent).toContain(LAB_OUTCOME);
  expect(host.querySelector('[aria-label="Cards in this view"]')?.textContent).not.toContain("Which train");
  expect(calls).toEqual([]);
});

test("in a lab build any other unknown address still goes home", async () => {
  const { host } = await mount("/nowhere");
  expect(host.textContent).toBe("Signed-out page");
});

describe("a build without VITE_FEED_LAB", () => {
  test("has no lab: the flag is off, nothing is loaded, and main.tsx keeps its redirect for unknown addresses", () => {
    expect(FEED_LAB).toBe(false);
    expect(lazyRoutes).toBeNull();
    const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8");
    expect(main).toContain('<Route path="*" element={FeedLabRoutes ? <Suspense fallback={null}><FeedLabRoutes /></Suspense> : <Navigate to="/" replace />} />');
  });
});

// VITE_FEED_LAB is read when lib/feedLab.ts loads, so each build runs in its own process.
describe("the signed-out page, by build", () => {
  const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
  function runFixture(feedLab: boolean) {
    const env = { ...process.env };
    if (feedLab) env.VITE_FEED_LAB = "true";
    else delete env.VITE_FEED_LAB;
    const result = spawnSync(process.execPath, ["test", "--isolate", "./test-fixtures/HomeWelcome.feedLab.fixture.tsx"], { cwd: frontendRoot, encoding: "utf8", env });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("0 fail");
  }
  test("a lab build links to the feed lab", () => { runFixture(true); }, 60_000);
  test("every other build has no link", () => { runFixture(false); }, 60_000);
});
