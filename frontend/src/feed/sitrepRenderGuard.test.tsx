/**
 * The board refuses to write a card holding a secret or an approval link, but a card from an agent the owner connected
 * never passes through the board: Home reads it as it was posted. So Home runs the same guard on every typed card it
 * reads, and a card that fails it is not a card with links or an approval, whatever its record says.
 */
import { afterEach, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { findSecrets, parseSitrepCardPayload, redactSecrets } from "@tinyboilerplate/core/feed/sitrep";
import { installDom } from "@/test/dom";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

// Radix portals do not attach in this DOM, so the sheet's chrome is an inline stand-in (as in SitrepFeed.test.tsx).
mock.module("../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; description?: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog" aria-label="sheet"><h2>{props.title}</h2><p>{props.description}</p>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { FeedViewEntries } = await import("./FeedView");

const TAP = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${"A".repeat(43)}&c=bafkrei${"a".repeat(52)}`;
const KEY = `sk-ant-${"a1B2".repeat(8)}`;

test("a typed card carrying a one-tap link or a key in any field is not a typed card, and a clean one still is", () => {
  const parse = (record: Record<string, unknown>) => parseSitrepCardPayload({ version: 1, record });
  const ask = syntheticRecord("ask");
  expect(parse(ask)?.record.kind).toBe("ask");
  expect(parse({ ...ask, links: [{ label: "Approve", url: TAP }] })).toBeNull();
  expect(parse({ ...ask, body: `Open ${TAP} to approve.` })).toBeNull();
  expect(parse({ ...ask, title: TAP })).toBeNull();
  expect(parse({ ...ask, body: `use ${KEY}` })).toBeNull();
  expect(parse({ ...syntheticRecord("approval"), body: `Open ${TAP} to approve.` })).toBeNull();
  // An approval's own consent page is still its link.
  const grant = { ...syntheticRecord("approval"), approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: ["SYNTHETIC_KEY"], scope: "synthetic-scope", url: "https://openkey.so/delegate?fixture=synthetic" };
  expect(parse(grant)?.record.kind).toBe("approval");
  expect(parse({ ...grant, url: TAP })).toBeNull();
});

function fixture(record: Record<string, unknown>, extraPayload: Record<string, unknown> = {}) {
  const entry: HomeFeedEntry = {
    source: { sourceId: "connected-agent", agentDid: "did:key:connected", label: "ConnectedAgent", output: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_connected" }, responses: { spaceId: "isolated-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_connected" } } as HomeFeedEntry["source"],
    state: {
      card: { cardId: `card-${String(record.id)}`, revision: 1, issuanceId: "issuance", kind: String(record.kind), needsResponse: true, urgency: 2, createdAt: String(record.createdAt), title: String(record.title), body: "A card body.",
        payload: { sitrep: { version: 1, record }, ...extraPayload } },
      response: null, acknowledgement: null, outcome: null,
    } as HomeFeedEntry["state"],
    view: { sourceId: "connected-agent", cardId: `card-${String(record.id)}`, revision: 1, issuanceId: "issuance" },
  };
  const snapshot: HomeFeedSnapshot = { entries: [entry], settings: { defaultSelector: "both" } };
  const source = {
    async load(focused?: boolean) {
      const loaded = structuredClone(snapshot);
      Object.assign(loaded, { sitrep: { answers: [], states: [], claimDecisions: [], threads: [], deliveries: [], heldNotes: [] }, ...(focused ? { focusedEntry: structuredClone(entry) } : {}) });
      return loaded;
    },
    async saveResponse() { throw new Error("not used"); },
    async sendMessage() { throw new Error("not used"); },
    async saveOwnerState() {},
    async saveHeldNote() {},
    async markSeen() { entry.view.seenAt = SITREP_NOW; },
    async snooze() {},
    async setDefaultSelector() {},
    subscribe() { return () => {}; },
  } as unknown as HomeFeedSource;
  return source;
}

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); restore?.(); restore = undefined;
});
async function mount(source: HomeFeedSource) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={source} />));
  // Needs you opens its first card itself; any card still a row is opened by a tap.
  for (let next = rowButton(host); next; next = rowButton(host)) await act(async () => next!.click());
  return host;
}
function rowButton(host: ParentNode) {
  return [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((item) => !item.querySelector("article"))
    .map((item) => item.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')).find(Boolean) ?? null;
}
const buttons = (host: ParentNode) => [...host.querySelectorAll("button")].map((node) => node.textContent?.trim() ?? "");
const anchors = (host: ParentNode) => [...host.querySelectorAll("a")].map((node) => node.getAttribute("href") ?? "");

test("a connected agent's approval carrying a one-tap link is not rendered as an approval, and has no link; the same card without it is", async () => {
  const clean = await mount(fixture(syntheticRecord("approval")));
  expect(buttons(clean).some((label) => /go/i.test(label) && /give|saving/i.test(label))).toBe(true);
  expect(clean.textContent).toContain("Approve the synthetic deploy window");
  await act(async () => { for (const root of roots) root.unmount(); roots.clear(); clean.remove(); });

  const record = { ...syntheticRecord("approval"), body: `Tap ${TAP} to approve.`, links: [{ label: "Approve here", url: TAP }] };
  const host = await mount(fixture(record));
  expect(buttons(host).some((label) => /give the go/i.test(label))).toBe(false);
  expect(anchors(host).filter((href) => href.includes("openkey.so/a/"))).toEqual([]);
  expect(host.textContent).not.toContain("Approve here");
});

test("a connected agent's plain link card, its source and its report with a one-tap link show no link", async () => {
  const record = { ...syntheticRecord("ask"), links: [] };
  const payload = { render: "link", url: TAP, source: { label: "Where from", url: TAP }, report: { label: "Full report", url: TAP } };
  const host = await mount(fixture(record, payload));
  expect(anchors(host).filter((href) => href.includes("openkey.so/a/"))).toEqual([]);
  const ok = { ...payload, url: "https://example.test/page", source: { label: "Where from", url: "https://example.test/src" }, report: { label: "Full report", url: "https://example.test/report" } };
  await act(async () => { for (const root of roots) root.unmount(); roots.clear(); host.remove(); });
  const control = await mount(fixture(record, ok));
  expect(anchors(control)).toEqual(expect.arrayContaining(["https://example.test/page", "https://example.test/report"]));
});

test("redacting takes out every kind of thing the guard refuses, leaves nothing the guard still matches, and leaves plain text alone", () => {
  const refused = [`Tap ${TAP} now`, `Use ${KEY}.`, "Authorization: Bearer abcdefghijklmnopqrstuv", "api_key = abcdefghijkl", "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----", "Go to https://openkey.so/delegate?user_code=ABCD-1234 please"];
  for (const text of refused) {
    const out = redactSecrets(text);
    expect(findSecrets(out), text).toEqual([]);
    expect(out, text).toContain("[link removed]");
  }
  expect(redactSecrets(`Tap ${TAP} now`)).toBe("Tap [link removed] now");
  const plain = "Ship TC-3236 after https://github.com/example/repo/pull/1 lands.";
  expect(redactSecrets(plain)).toBe(plain);
});

test("a refused card's Details shows the card as sent without the one-tap link or key", async () => {
  const record = { ...syntheticRecord("ask"), body: `Open ${TAP} to approve, key ${KEY}.`, links: [{ label: "Approve here", url: TAP }] };
  const host = await mount(fixture(record));
  const details = [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim().startsWith("Details"));
  expect(details !== undefined).toBe(true);
  await act(async () => details!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  expect(host.textContent).toContain("[link removed]");
  expect(host.textContent).not.toContain("openkey.so/a/");
  expect(host.textContent).not.toContain("A".repeat(43));
  expect(host.textContent).not.toContain("sk-ant-");
});
