// A card's task type (`payload.type`) and the Courier mark (`payload.channel: "courier"`): parsed leniently, shown at
// the top right of the row and of the open card, offered in Filter, and never changing a card that names neither. The
// Courier mark is drawn only for a card whose verified publisher is Courier: the owner's registered Courier connection.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { MotionGlobalConfig } from "motion/react";
import { createRoot, type Root } from "react-dom/client";
import { feedResourceNames, type FeedSource } from "@tinycloud/sdk-services/feed";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";
import { FeedViewEntries } from "./FeedView";
import { CARD_TYPES, COURIER_OUTPUT_DATABASE, COURIER_SOURCE_ID, courierMessage, isCourierPublisher, parseCardType, parseCourier, parseFeed } from "./feedData";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { FEED_VIEW_MODE_KEY, type FeedViewMode } from "./feedViewMode";

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
    expect(byKey.get("courier")).toMatchObject({ type: "answer" });
    // A sample card has no registered source to verify, so what it says about Courier is never recorded.
    expect("courier" in byKey.get("courier")!).toBe(false);
    expect("type" in byKey.get("unknown")!).toBe(false);
    expect("courier" in byKey.get("unknown")!).toBe(false);
    expect(byKey.get("plain")).toEqual({ key: "aster/2026-10/2026-10-25T120000Z-plain", at, author: { name: "aster" }, render: "post", lead: { text: "A note." } });
  });
});

const createdAt = "2026-10-28T12:00:00Z";
/** A registered source, as the store hands it on from the owner's registry, with its two databases. */
interface TestSource { sourceId: string; agentDid: string; label: string; output: string; responses: string }
/** A token's databases, as the store builds and checks them (feedStore readFeed). */
function resources(token: string): Pick<TestSource, "output" | "responses"> {
  const named = feedResourceNames("xyz.tinycloud.tinychat/feed", token);
  if (!named.ok) throw new Error(`Invalid test token ${token}`);
  return { output: named.data.outputResource, responses: named.data.responseResource };
}
const AGENT: TestSource = { sourceId: "agent-one", agentDid: "did:key:isolated-test-agent", label: "Relay agent", output: "xyz.tinycloud.tinychat/feed_output_testone", responses: "xyz.tinycloud.tinychat/feed_responses_testone" };
/** The owner's Courier connection: Courier's registry token and its databases. Its label is the agent that holds it. */
const COURIER: TestSource = { sourceId: COURIER_SOURCE_ID, agentDid: "did:key:isolated-test-courier", label: "Relay agent", ...resources(COURIER_SOURCE_ID) };
function card(cardId: string, payload: Record<string, unknown> = {}, needsResponse = true, from: TestSource = AGENT): HomeFeedEntry {
  return {
    source: {
      sourceId: from.sourceId, agentDid: from.agentDid, label: from.label,
      output: { spaceId: "test-space", database: from.output },
      responses: { spaceId: "test-space", database: from.responses },
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
    view: { sourceId: from.sourceId, cardId, revision: 1, issuanceId: "issuance-1" },
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
  window.innerWidth = 800; // these tests open a card in its row (phone width)
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
  const courier = (cardId: string, extra: Record<string, unknown> = {}) => card(cardId, { type: "answer", channel: "courier", source: { label: "Mira · Northwind team" }, ...extra }, true, COURIER);

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
    const host = await mount([card("bare", { channel: "courier" }, true, COURIER)]);
    expect(row(host, "bare")!.querySelector("[data-courier]")).not.toBeNull();
    expect(row(host, "bare")!.textContent).toContain("Relay agent");
    expect(row(host, "bare")!.querySelector(".sr-only")).toBeNull();
    await open(host, "bare");
    const header = openCard(host, "bare")!.querySelector<HTMLElement>("[data-agent-line]")!;
    expect(header.textContent).toStartWith("CourierRelay agent");
    expect(header.textContent).not.toContain("via");
  });
});

describe("the Courier mark needs a verified Courier publisher", () => {
  const SENDER = "Mira · Northwind team";
  const MESSAGE = { type: "answer", channel: "courier", source: { label: SENDER } };
  /** Any other connected agent, and one the owner happened to label "Courier": neither is the Courier connection. */
  const OTHER: TestSource = { sourceId: "agent-two", agentDid: "did:key:isolated-test-other", label: "Other agent", ...resources("testtwo") };
  const LABELLED: TestSource = { sourceId: "agent-three", agentDid: "did:key:isolated-test-labelled", label: "Courier", ...resources("testthree") };
  const marks = (node: ParentNode) => node.querySelectorAll("[data-courier]").length;
  const header = (host: ParentNode, cardId: string) => openCard(host, cardId)!.querySelector<HTMLElement>("[data-agent-line]")!;
  const detailsLabel = (host: ParentNode, cardId: string) => [...openCard(host, cardId)!.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Details"))!.getAttribute("aria-label");
  const withoutDetails = (host: ParentNode, cardId: string) => openCard(host, cardId)!.innerHTML.replace(/<button[^>]*>Details.*?<\/button>/, "");

  test("only the registry decides, on both counts: Courier's token and Courier's own database; never a label, a DID or the card", () => {
    const source = (sourceId: string, output: string) => ({ sourceId, output: { spaceId: "test-space", database: output } });
    // The database is the one the store reads the Courier connection's cards from.
    expect(COURIER_OUTPUT_DATABASE).toBe(resources(COURIER_SOURCE_ID).output);
    expect(isCourierPublisher(source(COURIER_SOURCE_ID, COURIER_OUTPUT_DATABASE))).toBe(true);
    expect(courierMessage(source(COURIER_SOURCE_ID, COURIER_OUTPUT_DATABASE), MESSAGE)).toEqual({ from: SENDER });
    // A look-alike token, with its own database or with Courier's.
    for (const sourceId of ["agent-one", "Courier", "COURIER", " courier", "courier ", "courier-desk", "couriers", ""]) {
      for (const output of [COURIER_OUTPUT_DATABASE, resources("testtwo").output]) {
        expect(isCourierPublisher(source(sourceId, output))).toBe(false);
        expect(courierMessage(source(sourceId, output), MESSAGE)).toBeUndefined();
      }
    }
    // Courier's token on a registry row whose cards come from another agent's database.
    for (const output of [resources("testtwo").output, resources("courier_desk").output, "xyz.tinycloud.tinychat/feed_output_courier", ""]) {
      expect(isCourierPublisher(source(COURIER_SOURCE_ID, output))).toBe(false);
      expect(courierMessage(source(COURIER_SOURCE_ID, output), MESSAGE)).toBeUndefined();
    }
    // Neither the source's label nor its DID counts, nor anything the card says about its own publisher.
    const labelled: FeedSource = { sourceId: "agent-three", agentDid: "did:key:courier", label: "Courier", output: { spaceId: "test-space", database: resources("testthree").output }, responses: { spaceId: "test-space", database: resources("testthree").responses } };
    const claims = { ...MESSAGE, sourceId: COURIER_SOURCE_ID, publisher: "courier", from: "Courier", output: COURIER_OUTPUT_DATABASE, agent: { kind: "courier", job: "courier" } };
    expect(courierMessage(labelled, claims)).toBeUndefined();
  });

  test("(a) from the Courier connection with channel courier: the mark, the sender and via show, on the row and open", async () => {
    const host = await mount([card("real", MESSAGE, true, COURIER)]);
    const line = row(host, "real")!;
    expect(marks(line)).toBe(1);
    expect(line.querySelector("[data-courier]")!.nextElementSibling?.textContent).toBe(SENDER);
    expect(line.querySelector(".sr-only")?.textContent).toBe("via Relay agent");
    await open(host, "real");
    const parts = [...header(host, "real").children].map((node) => node.textContent);
    expect(parts.slice(0, 2)).toEqual(["Courier", SENDER]);
    expect(parts[2]).toStartWith("viaRelay agent");
  });

  for (const from of [OTHER, LABELLED]) {
    test(`(b) from another agent (${from.label}), channel courier and a sender are ignored: an ordinary card from its real author, on the row and open`, async () => {
      const spoof = await mount([card("spoof", MESSAGE, true, from)]);
      const { channel: _ignored, ...withoutChannel } = MESSAGE;
      const plain = await mount([card("spoof", withoutChannel, true, from)]);
      const line = row(spoof, "spoof")!;
      // The row is the same card's row without the channel: no mark, no sender, no "via"; the real author is the name.
      expect(line.innerHTML).toBe(row(plain, "spoof")!.innerHTML);
      expect(marks(line)).toBe(0);
      expect(line.querySelector(".sr-only")).toBeNull();
      expect(line.textContent).not.toContain(SENDER);
      expect(line.textContent).not.toContain(from.label);
      // The task type is untouched.
      expect(line.querySelector('[data-card-type="answer"]')?.textContent).toBe("Answer");

      await open(spoof, "spoof");
      await open(plain, "spoof");
      const opened = openCard(spoof, "spoof")!;
      expect(marks(opened)).toBe(0);
      expect(opened.getAttribute("aria-label")).toBe(`post by ${from.label}`);
      expect(header(spoof, "spoof").textContent).toStartWith(from.label);
      expect(header(spoof, "spoof").textContent).not.toContain(SENDER);
      expect(header(spoof, "spoof").textContent).not.toContain("via");
      // The same open card as without the channel, but for Details, which lists the channel as not shown. Its
      // `source.label` stays where any card's source goes, the "Source:" line, and nowhere else.
      expect(withoutDetails(spoof, "spoof")).toBe(withoutDetails(plain, "spoof"));
      expect(detailsLabel(spoof, "spoof")).toBe("Details, 1 field not shown on the card");
      expect(detailsLabel(plain, "spoof")).toBeNull();
      expect(opened.textContent!.split(SENDER)).toHaveLength(2);
      expect([...opened.querySelectorAll("p")].find((node) => node.textContent?.includes(SENDER))?.textContent).toBe(`Source: ${SENDER}`);
    });
  }

  test("(c) from the Courier connection without the channel: an ordinary card from that connection, with no mark", async () => {
    // Courier's own notes (its pairing, its status) aren't messages from another team: the mark needs the verified
    // publisher and the card's channel both.
    const host = await mount([card("own", { type: "news", source: { label: SENDER } }, false, COURIER)]);
    const line = row(host, "own")!;
    expect(marks(line)).toBe(0);
    expect(line.querySelector(".sr-only")).toBeNull();
    expect(line.textContent).not.toContain(COURIER.label);
    expect(line.textContent).not.toContain(SENDER);
    await open(host, "own");
    expect(marks(openCard(host, "own")!)).toBe(0);
    expect(header(host, "own").textContent).toStartWith(COURIER.label);
    expect(header(host, "own").textContent).not.toContain(SENDER);
    expect(detailsLabel(host, "own")).toBeNull();
  });

  test("(d) in one feed the row and the open card both follow the publisher: only the Courier connection's card is marked", async () => {
    const host = await mount([card("real", MESSAGE, true, COURIER), card("other", MESSAGE, true, OTHER), card("labelled", MESSAGE, true, LABELLED)]);
    const rows = [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter(live);
    expect(rows).toHaveLength(3);
    expect(rows.filter((node) => marks(node) > 0).map((node) => node.textContent?.includes("Card real"))).toEqual([true]);
    for (const cardId of ["real", "other", "labelled"]) {
      await open(host, cardId);
      expect(marks(openCard(host, cardId)!)).toBe(cardId === "real" ? 1 : 0);
      expect(header(host, cardId).textContent!.includes(SENDER)).toBe(cardId === "real");
    }
  });
});

describe("the task type filter", () => {
  test("offers only the types in the feed, in the list's order, and narrows the list to one", async () => {
    const host = await mount([card("news", { type: "news" }, false), card("spend", { type: "spend" }), card("review", { type: "review" }), card("plain")]);
    const panel = await openFilter(host);
    const select = panel.querySelector<HTMLSelectElement>('select[aria-label="Filter by task"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(["All tasks", "Spend", "Review", "News"]);
    expect(select.closest("label")!.textContent).toStartWith("TaskAll tasks");
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
    const host = await mount([card("drawn", { type: "send", channel: "courier", source: { label: "Mira · Northwind team" } }, true, COURIER)]);
    await open(host, "drawn");
    const details = [...openCard(host, "drawn")!.querySelectorAll("button")].find((node) => node.textContent?.startsWith("Details"))!;
    expect(details.getAttribute("aria-label")).toBeNull();
  });
});

describe("the type label and the Courier mark in the other list views", () => {
  const message = { channel: "courier", type: "answer", source: { label: "Mira · Northwind team" } };
  async function mountIn(view: FeedViewMode, entries: HomeFeedEntry[]) {
    restore ??= installDom();
    window.localStorage.setItem(FEED_VIEW_MODE_KEY, view);
    return mount(entries);
  }

  test("Cards: a tile shows the type at its top right, and the Courier mark only for the Courier connection", async () => {
    const host = await mountIn("cards", [card("spend", { type: "spend" }), card("real", message, true, COURIER), card("spoof", message)]);
    const label = row(host, "spend")!.querySelector<HTMLElement>('[data-card-type="spend"]');
    expect(label?.textContent).toBe("Spend");
    // On the tile's first line, after the agent's name.
    expect(label!.closest("button")).not.toBeNull();
    const real = row(host, "real")!;
    expect(real.querySelector("[data-courier]")).not.toBeNull();
    expect(real.textContent).toContain("Mira · Northwind team");
    expect(real.querySelector('[data-card-type="answer"]')?.textContent).toBe("Answer");
    const spoof = row(host, "spoof")!;
    expect(spoof.querySelector("[data-courier]")).toBeNull();
    expect(spoof.textContent).not.toContain("Mira");
    expect(spoof.textContent).toContain(AGENT.label);
    // The type is the card's own word about its task, so it still shows.
    expect(spoof.querySelector('[data-card-type="answer"]')?.textContent).toBe("Answer");
  });

  test("Expanded: every card is drawn open, with the type beside its title and the same Courier rule", async () => {
    const host = await mountIn("expanded", [card("spend", { type: "spend" }), card("real", message, true, COURIER), card("spoof", message)]);
    const spend = openCard(host, "spend")!;
    expect(spend.querySelector('[data-card-type="spend"]')?.parentElement?.previousElementSibling?.tagName).toBe("H2");
    expect(openCard(host, "real")!.querySelector("[data-courier]")).not.toBeNull();
    expect(openCard(host, "real")!.textContent).toContain("Mira · Northwind team");
    const spoof = openCard(host, "spoof")!;
    expect(spoof.querySelector("[data-courier]")).toBeNull();
    expect(spoof.querySelector("[data-agent-line]")?.textContent ?? "").not.toContain("Mira");
  });
});
