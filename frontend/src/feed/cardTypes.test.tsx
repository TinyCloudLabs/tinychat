// A card's task type (`payload.type`) and the Courier mark (`payload.channel: "courier"`): parsed leniently, shown at
// the top right of the row and of the open card, offered in Filter, and never changing a card that names neither.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { FeedViewEntries } from "./FeedView";
import { CARD_TYPES, parseCardType, parseCourier, parseFeed } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";

const ALL_IDS = ["spend", "publish", "send", "access", "rule", "ship", "do", "review", "direction", "answer", "news", "alert"];

describe("parsing payload.type and payload.channel", () => {
  test("the twelve types, in precedence order, each with its word", () => {
    expect(CARD_TYPES.map((entry) => entry.id)).toEqual(ALL_IDS);
    expect(CARD_TYPES.map((entry) => entry.label)).toEqual(["Spend", "Publish", "Send", "Access", "Rule", "Ship", "Do", "Review", "Direction", "Answer", "News", "Alert"]);
    for (const id of ALL_IDS) expect(parseCardType(id)).toBe(id as never);
  });

  test("an unknown, differently cased, non-string or absent type is ignored", () => {
    for (const value of ["refund", "Spend", " spend", "", 3, null, undefined, { id: "spend" }, ["spend"]]) expect(parseCardType(value)).toBeUndefined();
  });

  test("courier needs channel courier; its sender is source.label, and a missing label leaves only the mark", () => {
    expect(parseCourier({ channel: "courier", source: { label: "Mira · Northwind team" } })).toEqual({ from: "Mira · Northwind team" });
    expect(parseCourier({ channel: "courier" })).toEqual({});
    expect(parseCourier({ channel: "courier", source: { label: "  " } })).toEqual({});
    for (const payload of [{ channel: "email", source: { label: "Mira" } }, { channel: "Courier" }, {}, null, "courier", undefined]) expect(parseCourier(payload)).toBeUndefined();
  });

  test("the KV feed keeps a known type and the Courier sender, and drops what it doesn't know without dropping the card", () => {
    const at = "2026-10-25T12:00:00Z";
    const base = { v: 1, at, render: "post", lead: { text: "A note." } };
    const cards = parseFeed([
      { key: "aster/2026-10/2026-10-25T120000Z-spend", value: { ...base, type: "spend" } },
      { key: "aster/2026-10/2026-10-25T120000Z-unknown", value: { ...base, type: "refund", channel: "pigeon" } },
      { key: "aster/2026-10/2026-10-25T120000Z-courier", value: { ...base, type: "answer", channel: "courier", source: { label: "Mira · Northwind team", url: "https://example.org/thread" } } },
      { key: "aster/2026-10/2026-10-25T120000Z-plain", value: base },
    ]);
    const byKey = new Map(cards.map((card) => [card.key.split("-").pop(), card]));
    expect(cards).toHaveLength(4);
    expect(byKey.get("spend")?.type).toBe("spend");
    expect(byKey.get("courier")).toMatchObject({ type: "answer", courier: { from: "Mira · Northwind team" } });
    expect("type" in byKey.get("unknown")!).toBe(false);
    expect("courier" in byKey.get("unknown")!).toBe(false);
    expect(byKey.get("plain")).toEqual({ key: "aster/2026-10/2026-10-25T120000Z-plain", at, author: { name: "aster" }, render: "post", lead: { text: "A note." } });
  });
});

const createdAt = "2026-10-28T12:00:00Z";
function card(cardId: string, payload: Record<string, unknown> = {}, needsResponse = true): HomeFeedEntry {
  return {
    source: {
      sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Relay agent",
      output: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_output_testone" },
      responses: { spaceId: "test-space", database: "xyz.tinycloud.tinychat/feed_responses_testone" },
    },
    state: {
      card: {
        cardId, revision: 1, issuanceId: "issuance-1", kind: needsResponse ? "ask" : "progress", needsResponse,
        title: `Card ${cardId}`, body: "A made-up card.", urgency: 1, createdAt,
        ...(needsResponse ? { choices: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] } : {}),
        payload,
      },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "agent-one", cardId, revision: 1, issuanceId: "issuance-1" },
  };
}
function source(entries: HomeFeedEntry[]): HomeFeedSource {
  const snapshot: HomeFeedSnapshot = { entries, settings: { defaultSelector: "both" } };
  return {
    async load() { return structuredClone(snapshot); },
    async saveResponse(_entry, response) { return { ...response, sequence: 1 }; },
    async markSeen() {},
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  };
}

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
const originalFetch = globalThis.fetch;
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  globalThis.fetch = originalFetch;
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  MotionGlobalConfig.skipAnimations = false;
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});
async function mount(entries: HomeFeedEntry[]) {
  restore ??= installDom();
  clock ??= installFakeClock();
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  globalThis.matchMedia = window.matchMedia.bind(window);
  MotionGlobalConfig.skipAnimations = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={source(entries)} />));
  return host;
}
const live = (node: Element) => !node.closest("[inert]");
const row = (host: ParentNode, cardId: string) => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter(live).find((node) => node.textContent?.includes(`Card ${cardId}`)) ?? null;
const openCard = (host: ParentNode, cardId: string) => [...host.querySelectorAll<HTMLElement>("article")].filter(live).find((node) => node.querySelector("h2")?.textContent === `Card ${cardId}`) ?? null;
async function open(host: ParentNode, cardId: string) {
  await act(async () => row(host, cardId)!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
  expect(openCard(host, cardId)).not.toBeNull();
}
async function openFilter(host: HTMLElement) {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-controls="home-feed-filters"]')!.click());
  // The panel is its own lazy chunk.
  for (let tries = 0; tries < 20 && !host.querySelector("#home-feed-filters"); tries++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return host.querySelector<HTMLElement>("#home-feed-filters")!;
}

describe("the type label", () => {
  test("shows its word at the top of the row's end, and beside the title on the open card", async () => {
    const host = await mount([card("spend", { type: "spend" }), card("news", { type: "news" }, false), card("alert", { type: "alert" }, false)]);
    for (const [cardId, word] of [["spend", "Spend"], ["news", "News"], ["alert", "Alert"]] as const) {
      const label = row(host, cardId)!.querySelector<HTMLElement>(`[data-card-type="${cardId}"]`);
      expect(label?.textContent).toBe(word);
      // First in the row's end column, above the time and the status.
      expect(label!.parentElement!.firstElementChild).toBe(label);
      expect(label!.closest("button")).not.toBeNull();
      expect(label!.tagName).toBe("SPAN");
    }
    await open(host, "spend");
    const opened = openCard(host, "spend")!;
    const label = opened.querySelector<HTMLElement>('[data-card-type="spend"]');
    expect(label?.textContent).toBe("Spend");
    expect(label!.closest("button")).toBeNull();
    // Beside the title, after it: the top right of the card's content.
    expect(label!.parentElement!.previousElementSibling?.tagName).toBe("H2");
  });

  test("the four outbound types share one accent and an arrow; Alert takes the warning colour; the rest are neutral", async () => {
    const host = await mount(ALL_IDS.map((id) => card(id, { type: id }, id !== "news" && id !== "alert")));
    for (const id of ALL_IDS) {
      const label = row(host, id)!.querySelector<HTMLElement>(`[data-card-type="${id}"]`)!;
      const outbound = ["spend", "publish", "send", "access"].includes(id);
      expect(label.className.includes("text-primary")).toBe(outbound);
      expect(!!label.querySelector("svg")).toBe(outbound || id === "alert");
      expect(label.className.includes("text-warning")).toBe(id === "alert");
    }
  });
});

describe("the Courier mark", () => {
  const courier = (cardId: string, extra: Record<string, unknown> = {}) => card(cardId, { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" }, ...extra });

  test("the row leads with Courier and the sender as the name; the relaying agent is in its accessible text", async () => {
    const host = await mount([courier("asks")]);
    const line = row(host, "asks")!;
    const mark = line.querySelector<HTMLElement>("[data-courier]")!;
    expect(mark.textContent).toBe("Courier");
    expect(mark.querySelector("svg")).not.toBeNull();
    expect(mark.nextElementSibling?.textContent).toBe("Mira · Northwind team");
    expect(line.querySelector(".sr-only")?.textContent).toBe("via Relay agent");
    expect(line.textContent).not.toContain("A made-up card.");
  });

  test("the open card's first line shows Courier, the sender, and smaller, via the agent that relayed it", async () => {
    const host = await mount([courier("asks"), courier("informs", { type: "news" })]);
    await open(host, "asks");
    const header = openCard(host, "asks")!.querySelector<HTMLElement>("[data-agent-line]")!;
    const parts = [...header.children].map((node) => node.textContent);
    expect(parts[0]).toBe("Courier");
    expect(parts[1]).toBe("Mira · Northwind team");
    expect(parts[2]).toStartWith("viaRelay agent");
    expect(header.children[2]!.className).toContain("text-xs");
  });

  test("courier without a sender keeps the relaying agent as the name, with the mark", async () => {
    const host = await mount([card("bare", { channel: "courier" })]);
    expect(row(host, "bare")!.querySelector("[data-courier]")).not.toBeNull();
    expect(row(host, "bare")!.textContent).toContain("Relay agent");
    expect(row(host, "bare")!.querySelector(".sr-only")).toBeNull();
    await open(host, "bare");
    const header = openCard(host, "bare")!.querySelector<HTMLElement>("[data-agent-line]")!;
    expect(header.textContent).toStartWith("CourierRelay agent");
    expect(header.textContent).not.toContain("via");
  });
});

describe("the task type filter", () => {
  test("offers only the types in the feed, in the list's order, and narrows the list to one", async () => {
    const host = await mount([card("news", { type: "news" }, false), card("spend", { type: "spend" }), card("review", { type: "review" }), card("plain")]);
    const panel = await openFilter(host);
    const select = panel.querySelector<HTMLSelectElement>('select[aria-label="Filter by task type"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["All tasks", "Spend", "Review", "News"]);
    expect(select.closest("label")!.textContent).toStartWith("Task type");
    await act(async () => {
      select.value = "review";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(row(host, "review")).not.toBeNull();
    for (const other of ["news", "spend", "plain"]) expect(row(host, other)).toBeNull();
    expect(host.querySelector('button[aria-controls="home-feed-filters"]')!.getAttribute("aria-label")).toBe("Filter, 1 on");
  });

  test("a feed with no typed cards shows Filter as before, without it", async () => {
    const host = await mount([card("plain"), card("odd", { type: "refund" })]);
    const panel = await openFilter(host);
    const controls = [...panel.querySelectorAll<HTMLElement>("select, button")].map((node) => node.tagName === "SELECT" ? node.getAttribute("aria-label") : node.textContent);
    expect(controls).toEqual(["Filter by type", "Filter by priority", "Order", "Snoozed"]);
  });
});

describe("a card without the new fields", () => {
  test("renders as before: a type or channel the app doesn't know changes nothing on the card, and Details lists it as not shown", async () => {
    const payload = { source: { label: "Source record", url: "https://example.org/source" } };
    const plain = await mount([card("same", payload)]);
    const odd = await mount([card("same", { ...payload, type: "refund", channel: "pigeon" })]);
    expect(row(odd, "same")!.innerHTML).toBe(row(plain, "same")!.innerHTML);
    expect(row(plain, "same")!.querySelector("[data-card-type], [data-courier]")).toBeNull();
    await open(plain, "same");
    await open(odd, "same");
    const details = (host: ParentNode) => [...openCard(host, "same")!.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Details"))!;
    expect(details(plain).getAttribute("aria-label")).toBeNull();
    expect(details(odd).getAttribute("aria-label")).toBe("Details, 2 fields not shown on the card");
    // Apart from Details' count, the open cards are the same.
    const withoutDetails = (host: ParentNode) => openCard(host, "same")!.innerHTML.replace(/<button[^>]*>Details.*?<\/button>/, "");
    expect(withoutDetails(odd)).toBe(withoutDetails(plain));
    expect(openCard(plain, "same")!.querySelector("[data-card-type], [data-courier]")).toBeNull();
    // The title is the card's own heading, straight under the meta line, not wrapped beside a label.
    expect(openCard(plain, "same")!.querySelector("h2")!.parentElement!.tagName).toBe("ARTICLE");
  });

  test("a known type and the Courier channel are drawn, so Details doesn't list them", async () => {
    const host = await mount([card("drawn", { type: "send", channel: "courier", source: { label: "Mira · Northwind team" } })]);
    await open(host, "drawn");
    const details = [...openCard(host, "drawn")!.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Details"))!;
    expect(details.getAttribute("aria-label")).toBeNull();
  });
});
