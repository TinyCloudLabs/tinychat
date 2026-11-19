import { afterEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

// Radix portals do not attach in happy-dom; the sheets are swapped for inline stand-ins (as in SitrepFeed.test.tsx).
mock.module("../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; children?: ReactNode }) => props.open ? <div role="dialog">{props.children}</div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { FeedViewEntries } = await import("./FeedView");

function source(payload: Record<string, unknown>, extra: Record<string, unknown> = {}): HomeFeedSource {
  const card = { cardId: "trip", revision: 1, issuanceId: "trip-1", kind: "decision", needsResponse: true, title: "Which train should I hold for Friday?", body: "Two trains reach the workshop before 14:00.",
    choices: [{ id: "early", label: "08:15 direct" }, { id: "late", label: "09:40, one change" }], urgency: 2, createdAt: "2026-11-13T11:51:00.000Z", payload, ...extra } as FeedCard;
  const entry: HomeFeedEntry = {
    source: { sourceId: "trip-agent", agentDid: "did:key:trip", label: "Trip agent", output: { spaceId: "s", database: "xyz.tinycloud.tinychat/feed/feed_output_trip" }, responses: { spaceId: "s", database: "xyz.tinycloud.tinychat/feed/feed_responses_trip" } },
    state: { card, response: null, acknowledgement: null, outcome: null },
    view: { sourceId: "trip-agent", cardId: "trip", revision: 1, issuanceId: "trip-1" },
  };
  const snapshot: HomeFeedSnapshot = { entries: [entry], settings: { defaultSelector: "both" } };
  const refuse = async () => { throw new Error("not in this test"); };
  return {
    async load() { return structuredClone(snapshot); },
    saveResponse: refuse, sendMessage: refuse, async markSeen() {}, snooze: refuse, async setDefaultSelector() {},
    subscribe() { return () => {}; },
  } as unknown as HomeFeedSource;
}

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => { for (const root of roots) await act(async () => root.unmount()); roots.clear(); restore?.(); restore = undefined; });

/** The open card, its Details toggle, and Details unfolded. */
async function openDetails(feed: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={feed} />));
  const opener = [...host.querySelectorAll<HTMLElement>("button[aria-expanded=false]")].find((node) => node.textContent?.includes("Which train"));
  if (opener) await act(async () => opener.click());
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((node) => node.textContent?.trim().startsWith("Details"));
  expect(toggle !== undefined).toBe(true);
  const closedLabel = toggle!.getAttribute("aria-label");
  const closedText = toggle!.textContent;
  await act(async () => toggle!.click());
  return { host, closedLabel, closedText, panel: host.querySelector<HTMLElement>('[aria-label="Details"]') };
}

test("a card says in its foot how many of its fields it does not draw, and Details lists them exactly as sent, as text", async () => {
  const { closedLabel, closedText, panel } = await openDetails(source(
    { summary: "Hold a seat?", cost: "£24.50 return, refundable until Thursday 18:00", seat: { coach: "C", seat: 42 }, timetable: "https://trains.example/0815", photo: "https://trains.example/seat.png" },
    { tags: ["travel"] },
  ));
  expect(closedLabel).toBe("Details, 5 fields not shown on the card");
  expect(closedText).toContain("+5");
  const list = panel!.querySelector('[aria-label="Not shown on the card"]')!;
  expect([...list.querySelectorAll("code")].map((node) => node.textContent)).toEqual(["payload.cost", "payload.seat", "payload.timetable", "payload.photo", "tags"]);
  // Each field reads by its name in plain words, the path in small type under it.
  expect([...list.querySelectorAll("li")].map((node) => node.querySelector("span > span")?.textContent)).toEqual(["Cost", "Seat", "Timetable", "Photo", "Tags"]);
  expect(list.textContent).toContain("£24.50 return, refundable until Thursday 18:00");
  expect(list.textContent).toContain('"coach": "C"');
  expect(list.textContent).toContain("https://trains.example/0815");
  // A value is never opened or loaded: no link, no image, however it reads.
  expect(list.querySelectorAll("a, img").length).toBe(0);
  expect(list.textContent).toContain("exactly as Trip agent sent them");
});

test("a card that draws all of its data has no count in its foot and no list in Details, and still offers the card as sent", async () => {
  const { closedLabel, closedText, panel } = await openDetails(source({ summary: "Hold a seat?" }));
  // With nothing hidden, the button is named by its own text.
  expect(closedLabel).toBe(null);
  expect(closedText?.trim()).toBe("Details");
  expect(panel!.querySelector('[aria-label="Not shown on the card"]')).toBe(null);
  const data = [...panel!.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.startsWith("Card data"))!;
  await act(async () => data.click());
  expect(panel!.querySelector('[aria-label="Card data"] pre')?.textContent).toContain('"cardId": "trip"');
});
