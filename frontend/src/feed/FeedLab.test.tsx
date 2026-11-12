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
import { createFeedLabSource, LAB_COMPLETED_MS, LAB_OUTCOME, LAB_RECEIVED_MS, LAB_REPLY_MS, LAB_REPLY_RECEIVED_MS, LAB_SAVE_MS, labReplyText } from "./feedLabSource";
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

async function enter(host: HTMLElement, selector: string, text: string) {
  const node = host.querySelector<HTMLTextAreaElement>(selector);
  expect(node).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(node, text);
    node!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("the seven made-up cards are two plain questions, a plain update, three typed asks and a typed approval", async () => {
  const { entries } = await createFeedLabSource().load();
  expect(entries).toHaveLength(7);
  const plain = entries.filter((entry) => entry.state.card.payload?.sitrep === undefined);
  expect(plain.filter((entry) => entry.state.card.needsResponse).map((entry) => entry.state.card.choices?.length)).toEqual([2, 3]);
  expect(plain.filter((entry) => !entry.state.card.needsResponse).map((entry) => entry.state.card.choices)).toEqual([undefined]);
  const records = entries.flatMap((entry) => entry.state.card.payload?.sitrep === undefined ? [] : [parseSitrepCardPayload(entry.state.card.payload.sitrep)?.record]);
  expect(records.map((record) => record?.kind)).toEqual(["ask", "ask", "approval", "ask"]);
  // One card's owner has a link the person approved, so both ways a reply goes can be tried.
  const linked = entries.filter((entry) => entry.recipientRoute?.recipients.some((recipient) => recipient.runtimeTarget));
  expect(linked.map((entry) => [entry.source.label, parseSitrepCardPayload(entry.state.card.payload?.sitrep)?.record.from])).toEqual([["Studio crew", "Kiln agent"]]);
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

test("in the lab a reply to the linked agent counts down, is received, and is answered about two seconds later", async () => {
  jest.useFakeTimers();
  const { host, calls } = await mount(FEED_LAB_PATH);
  const pass = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); });
  const glaze = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Cards in this view"] button')].find((node) => node.textContent?.includes("Which glaze"));
  await act(async () => glaze!.click());
  expect(host.querySelector('[aria-label="Focused card"] [data-agent-line]')?.textContent).toBe("Kiln agentMuse");
  expect(host.querySelector('[aria-label="Focused card"] article')?.textContent).toContain("via Studio crew");
  await act(async () => [...host.querySelectorAll<HTMLButtonElement>("fieldset button")].find((node) => node.textContent?.startsWith("Celadon"))!.click());
  expect(host.textContent).toContain(`Sending to Kiln agent in ${ANSWER_UNDO_SECONDS}s`);
  await pass(ANSWER_UNDO_SECONDS * 1_000 + LAB_SAVE_MS);
  const fold = () => host.querySelector('[aria-label="Answer sent"]');
  expect(fold()?.textContent).toContain("Sent to Kiln agent");
  await act(async () => button(host, "Reply to Kiln agent").click());
  await enter(host, '[aria-label="Answer sent"] textarea[name="reply"]', "Use the darker celadon please.");
  await act(async () => button(host, "Send").click());
  expect(button(host, `Sending to Kiln agent in ${ANSWER_UNDO_SECONDS}s`).disabled).toBe(true);
  await pass(ANSWER_UNDO_SECONDS * 1_000 + LAB_SAVE_MS);
  const latest = () => host.querySelector('[aria-label="Latest in the conversation"]');
  expect(latest()?.textContent).toContain("You to Kiln agent");
  expect(latest()?.textContent).toContain("Use the darker celadon please.");
  expect(latest()?.querySelector('[data-step="received"]')?.getAttribute("data-state")).toBe("upcoming");
  await pass(LAB_REPLY_RECEIVED_MS);
  expect(latest()?.querySelector('[data-step="received"]')?.getAttribute("data-state")).toBe("done");
  expect(latest()?.textContent).toContain("Kiln agent received it");
  await pass(LAB_REPLY_MS - LAB_REPLY_RECEIVED_MS);
  expect(latest()?.textContent).toContain(labReplyText("Use the darker celadon please."));
  await act(async () => button(host, "Show card").click());
  const thread = host.querySelector('[aria-label="Card thread"] ol')?.textContent;
  expect(thread).toContain("Use the darker celadon please.");
  expect(thread).toContain(labReplyText("Use the darker celadon please."));
  expect(calls).toEqual([]);
});

test("each made-up agent says what it runs on, except Backup agent, which says nothing", async () => {
  const { entries } = await createFeedLabSource().load();
  const platforms = new Map(entries.map((entry) => [parseSitrepCardPayload(entry.state.card.payload?.sitrep)?.record.from ?? entry.source.label, (entry.state.card.payload?.agent as { kind?: string } | undefined)?.kind]));
  expect(Object.fromEntries(platforms)).toEqual({ "Trip agent": "codex", "Home agent": "grok", "Backup agent": undefined, "Studio agent": "claude", "Kiln agent": "muse" });
});

test("in the lab the open card is one surface: the agent line, question, options, reply and small actions, then the list under headings", async () => {
  const { host } = await mount(FEED_LAB_PATH);
  const card = host.querySelector<HTMLElement>('[aria-label="Focused card"] article')!;
  // The agent line: its mark, its name and its platform, Codex, which has no mark file, so its name alone.
  expect(card.querySelector("[data-agent-mark]")?.textContent).toBe("T");
  expect(card.querySelector("[data-agent-line]")?.textContent).toBe("Trip agentCodex");
  expect(card.querySelector("[data-agent-line] [data-platform-logo]")).toBeNull();
  for (const part of ["h2", "fieldset", 'textarea[name="answer"]', '[aria-label="Card actions"]']) expect(card.querySelector(part)).not.toBeNull();
  const actions = card.querySelector('[aria-label="Card actions"]')!;
  expect([...actions.querySelectorAll("button, summary")].map((node) => node.textContent)).toEqual(["Snooze for 1 hour", "Next card", "Details"]);
  // Everything else in the view is a list under plain headings with a count, not more cards.
  const list = host.querySelector('[aria-label="Cards in this view"]')!;
  expect([...list.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Also needs you · 5"]);
  expect(list.textContent).not.toContain("Which train");
  const glaze = [...list.querySelectorAll("button")].find((row) => row.textContent?.includes("Which glaze"))!;
  expect(glaze.querySelector("[data-agent-mark]")?.textContent).toBe("K");
  expect(glaze.textContent).toBe("KWhich glaze should the open-day mugs get?Kiln agent · Muse");
  const letter = [...list.querySelectorAll("button")].find((row) => row.textContent?.includes("spring newsletter"))!;
  expect(letter.querySelector('[data-platform-logo="claude.svg"][role="img"]')?.getAttribute("aria-label")).toBe("Claude");
  // The same agent has the same mark in the list and on its card.
  const colour = (node: Element | null | undefined) => node?.className.match(/\bbg-\S+/)?.[0];
  const mark = colour(letter.querySelector("[data-agent-mark]"));
  expect(mark).toBeDefined();
  await act(async () => letter.click());
  expect(colour(host.querySelector('[aria-label="Focused card"] [data-agent-mark]'))).toBe(mark);
  const option = [...host.querySelectorAll<HTMLButtonElement>("fieldset button")].find((node) => node.textContent?.startsWith("Short version"))!;
  expect(option.textContent).toBe("Short versionSuggestedThree paragraphs and the dates. Ready to send today.");
  expect([...host.querySelectorAll<HTMLButtonElement>("fieldset button")].filter((node) => node.textContent?.includes("Suggested"))).toHaveLength(1);
  // Private priority waits under Details.
  const details = host.querySelector<HTMLDetailsElement>('[aria-label="Focused card"] [aria-label="Card details"]')!;
  expect(details.open).toBe(false);
  expect(details.textContent).toContain("Mark private priority");
  expect([...host.querySelectorAll('[aria-label="Focused card"] [aria-label="Card actions"] > button')].map((node) => node.textContent)).toEqual(["Ask me later", "Next card"]);
});

test("in the lab an update sits under its own heading, and a card whose agent named no platform has no chip", async () => {
  const { host } = await mount(FEED_LAB_PATH);
  const view = host.querySelector<HTMLSelectElement>('[aria-label="Feed view"]')!;
  await act(async () => { view.value = "both"; view.dispatchEvent(new Event("change", { bubbles: true })); });
  const list = host.querySelector('[aria-label="Cards in this view"]')!;
  expect([...list.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual(["Also needs you · 5", "Updates · 1"]);
  const backup = [...list.querySelectorAll('section[aria-label="Updates"] button')].find((row) => row.textContent?.includes("Weekly backup"))!;
  expect(backup.textContent).toBe("BWeekly backup finishedBackup agent · Information");
  await act(async () => (backup as HTMLButtonElement).click());
  const card = host.querySelector('[aria-label="Focused card"] article')!;
  expect(card.querySelector("[data-agent-line]")?.textContent).toBe("Backup agent");
  expect(card.querySelector("[data-platform]")).toBeNull();
  await act(async () => button(host, "Backup agent").click());
  expect(card.querySelector('[aria-label="About Backup agent"]')?.textContent).toContain("Backup agent has not said what it is or where it runs.");
});

test("in the lab tapping an agent's name shows what it is, and the same facts head its page and its row in the Agents list", async () => {
  const { host } = await mount(FEED_LAB_PATH);
  const name = button(host, "Trip agent");
  expect(name.getAttribute("aria-expanded")).toBe("false");
  await act(async () => name.click());
  const about = host.querySelector('[aria-label="Focused card"] [aria-label="About Trip agent"]')!;
  const rows = [...about.querySelectorAll("dl > div")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);
  expect(rows).toEqual([["What it is", "Codex"], ["Model", "GPT-5.2-Codex"], ["Runs on", "Your laptop"], ["It can", "Post cards to your Home and read your answers to them"]]);
  expect(about.textContent).not.toContain("Disconnect");
  await act(async () => button(host, "Open conversation").click());
  const page = host.querySelector('[aria-label="Conversation with Trip agent"]')!;
  expect(page.querySelector("[data-agent-mark]")?.textContent).toBe("T");
  expect(page.querySelector('[aria-label="About Trip agent"]')?.textContent).toContain("GPT-5.2-Codex");
  await act(async () => button(host, "Agents").click());
  const agents = [...host.querySelectorAll('[aria-label="Your agents"] li')];
  const studio = agents.find((row) => row.textContent?.includes("Studio agent"))!;
  expect(studio.querySelector('[data-platform-logo="claude.svg"]')).not.toBeNull();
  const backup = agents.find((row) => row.textContent?.includes("Backup agent"));
  expect(backup?.querySelector("[data-platform]") ?? null).toBeNull();
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
