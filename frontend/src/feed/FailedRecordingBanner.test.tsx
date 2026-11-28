import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import type { CalendarAutojoinOutcome } from "@/lib/connectors/calendarAutojoinApi";
import { createFailedRecordingDismissals, FAILED_RECORDING_WINDOW_MS } from "@/lib/connectors/failedRecordingNotice";
import { FailedRecordingBanner } from "./FailedRecordingBanner";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  restore?.();
  restore = undefined;
});

const NOW = Date.parse("2026-11-28T12:00:00.000Z");
const SUBJECT = "did:pkh:eip155:1:0xowner";
const failed = (id: string, over: Partial<CalendarAutojoinOutcome> = {}): CalendarAutojoinOutcome =>
  ({ id, title: `Meeting ${id}`, start: NOW - 3600_000, reason: "failed", ...over });
const memoryStorage = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
};

/** `reads` is consumed one per status read; the last entry repeats. A function entry runs on that read. */
function fakeCalendar(reads: Array<CalendarAutojoinOutcome[] | Error>) {
  let index = 0;
  let count = 0;
  return {
    get reads() { return count; },
    status: async () => {
      count++;
      const next = reads[Math.min(index++, reads.length - 1)]!;
      if (next instanceof Error) throw next;
      return { outcomes: next };
    },
  };
}

async function mount(calendar: ReturnType<typeof fakeCalendar>, opts: { subject?: string | null; now?: () => number; pollMs?: number; dismissals?: ReturnType<typeof createFailedRecordingDismissals> } = {}) {
  restore = installDom();
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const dismissals = opts.dismissals ?? createFailedRecordingDismissals(() => memoryStorage());
  await act(async () => root!.render(
    <FailedRecordingBanner calendar={calendar} subject={opts.subject === undefined ? SUBJECT : opts.subject} dismissals={dismissals} now={opts.now ?? (() => NOW)} pollMs={opts.pollMs ?? 3_600_000} />,
  ));
  return {
    container,
    text: () => container.textContent ?? "",
    card: () => container.querySelector("[data-testid=failed-recording-banner]"),
    dismiss: () => act(async () => { container.querySelector("button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); }),
    wait: (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }),
    dismissals,
  };
}

test("a failed recording from the last day shows the card with the reason in plain words", async () => {
  const view = await mount(fakeCalendar([[failed("a", { title: "Weekly sync", failureCode: "bot_removed" })]]));
  expect(view.card()?.getAttribute("role")).toBe("status");
  expect(view.text()).toContain("A meeting recording did not finish");
  expect(view.text()).toContain("Weekly sync: The notetaker was removed from the meeting.");
  expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe("Dismiss notice about Weekly sync");
  expect(view.container.querySelector("button")?.textContent).toBe("Dismiss");
});

test("nothing shows for other outcomes, for older recordings or before sign-in", async () => {
  expect((await mount(fakeCalendar([[failed("a", { reason: "missed" }), failed("b", { reason: "not_accepted" })]]))).card()).toBeNull();
  await act(async () => root!.unmount()); restore?.();
  expect((await mount(fakeCalendar([[failed("a", { start: NOW - FAILED_RECORDING_WINDOW_MS })]]))).card()).toBeNull();
  await act(async () => root!.unmount()); restore?.();
  const calendar = fakeCalendar([[failed("a")]]);
  expect((await mount(calendar, { subject: null })).card()).toBeNull();
  expect(calendar.reads).toBe(0);
});

test("a failed read shows nothing", async () => {
  const view = await mount(fakeCalendar([new Error("offline")]));
  expect(view.card()).toBeNull();
  expect(view.text()).toBe("");
});

test("a later failed read leaves a card that is showing in place", async () => {
  const calendar = fakeCalendar([[failed("a")], new Error("offline")]);
  const view = await mount(calendar, { pollMs: 10 });
  expect(view.card()).not.toBeNull();
  await view.wait(60);
  expect(calendar.reads).toBeGreaterThan(1);
  expect(view.card()).not.toBeNull();
});

test("Dismiss hides every recording the card counts, and survives a reload of the card", async () => {
  const dismissals = createFailedRecordingDismissals(() => memoryStorage());
  const calendar = fakeCalendar([[failed("a", { title: "Latest" }), failed("b", { start: NOW - 7200_000 }), failed("c", { start: NOW - 10800_000 })]]);
  const view = await mount(calendar, { dismissals });
  expect(view.text()).toContain("3 meeting recordings did not finish");
  expect(view.text()).toContain("Most recent, Latest: ");
  expect(view.container.querySelector("button")?.getAttribute("aria-label")).toBe("Dismiss notice about these recordings");
  await view.dismiss();
  expect(view.card()).toBeNull();
  expect([...dismissals.read(SUBJECT)].sort()).toEqual(["a", "b", "c"]);
  await act(async () => root!.unmount()); restore?.();
  expect((await mount(fakeCalendar([[failed("a"), failed("b"), failed("c")]]), { dismissals })).card()).toBeNull();
});

test("a recording that fails after a dismissal shows its own card", async () => {
  const dismissals = createFailedRecordingDismissals(() => memoryStorage());
  const calendar = fakeCalendar([[failed("a")], [failed("a"), failed("b", { title: "Next", start: NOW - 60_000 })]]);
  const view = await mount(calendar, { dismissals, pollMs: 10 });
  expect(view.card()).not.toBeNull();
  await view.dismiss();
  expect(view.card()).toBeNull();
  await view.wait(60);
  expect(view.text()).toContain("A meeting recording did not finish");
  expect(view.text()).toContain("Next: ");
  expect(view.text()).not.toContain("recordings did not finish");
});

test("an unchanged poll leaves the card's elements untouched, so nothing is announced again", async () => {
  const calendar = fakeCalendar([[failed("a")]]);
  const view = await mount(calendar, { pollMs: 10 });
  const before = view.card();
  let mutations = 0;
  const observer = new MutationObserver(() => { mutations++; });
  observer.observe(view.container, { subtree: true, childList: true, characterData: true, attributes: true });
  await view.wait(80);
  observer.disconnect();
  expect(calendar.reads).toBeGreaterThan(2);
  expect(view.card()).toBe(before);
  expect(mutations).toBe(0);
});

test("a recording drops off the card once its day has passed", async () => {
  let clock = NOW;
  const calendar = fakeCalendar([[failed("a", { start: NOW - 3600_000 })]]);
  const view = await mount(calendar, { pollMs: 10, now: () => clock });
  expect(view.card()).not.toBeNull();
  clock = NOW + FAILED_RECORDING_WINDOW_MS;
  await view.wait(60);
  expect(view.card()).toBeNull();
});
