/**
 * A read grant may cover up to 20 secret names; a write grant still covers at most 10. Every path that reads a board
 * record (the schema, the card payload parser, an upsert) takes the same bound, and Home draws every name of a
 * 20-name grant on the card itself, before the link that approves it.
 */
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyUpsert, parseSitrepCardPayload, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import { installDom } from "@/test/dom";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_NOW, syntheticRecord } from "./sitrep.fixtures";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in, as in unshownSitrep.test.tsx. The
// Home UI is imported after the mock is registered, so its import has to be dynamic.
mock.module("../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog" aria-label="sheet"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { FeedViewEntries } = await import("./FeedView");

const namesOf = (count: number): string[] => Array.from({ length: count }, (_, index) => `SYNTHETIC_KEY_${String(index + 1).padStart(2, "0")}`);

/** An OpenKey read grant of the shape the officers post today, covering `count` names. */
const readGrant = (count: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...syntheticRecord("approval"), approvalType: "openkey", approvalKind: undefined, codeExpected: true, names: namesOf(count), scope: "synthetic-scope",
  url: "https://openkey.so/delegate?fixture=synthetic", ...extra,
});

/** A write grant: a reason for every name, as the card requires. */
const writeGrant = (names: string[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...readGrant(1), names, grantMode: "write", nameWhy: names.slice(0, 10).map((name) => ({ name, why: `Stores ${name.toLowerCase()}.` })), ...extra,
});

const errorsOf = (record: Record<string, unknown>): string[] => {
  const checked = validateRecord("approval", record);
  return checked.ok ? [] : checked.errors;
};

test("a read grant covers 20 names and refuses a 21st, whichever list carries it", () => {
  expect(errorsOf(readGrant(20))).toEqual([]);
  expect(errorsOf(readGrant(20, { copiedNames: namesOf(20), keepNames: namesOf(20) }))).toEqual([]);
  for (const field of ["names", "copiedNames", "keepNames"]) {
    const errors = errorsOf(readGrant(21, field === "names" ? {} : { [field]: namesOf(21) }));
    expect(errors.some((message) => message.startsWith(`${field}:`)), field).toBe(true);
  }
});

test("a write grant still covers at most 10 names", () => {
  expect(errorsOf(writeGrant(namesOf(10)))).toEqual([]);
  const eleven = errorsOf(writeGrant(namesOf(11)));
  expect(eleven.some((message) => message.includes("a write grant covers at most 10 names"))).toBe(true);
  // A name listed twice still counts, and nameWhy alone may not carry more than 10.
  expect(errorsOf(writeGrant([...namesOf(10), "SYNTHETIC_KEY_01"])).some((message) => message.includes("a write grant covers at most 10 names"))).toBe(true);
  expect(errorsOf(writeGrant(namesOf(10), { nameWhy: namesOf(11).map((name) => ({ name, why: "Stores it." })) })).some((message) => message.startsWith("nameWhy:"))).toBe(true);
});

test("a card payload with 20 names is read, and one with 21 is not", () => {
  const payload = (count: number) => ({ version: 1, record: readGrant(count) });
  expect(parseSitrepCardPayload(payload(20))?.record.kind).toBe("approval");
  expect(parseSitrepCardPayload(payload(21))).toBe(null);
});

test("a card that already covers 20 names takes an update", () => {
  const checked = validateRecord("approval", readGrant(20));
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const outcome = applyUpsert("approval", checked.value.id, checked.value, { urgency: 4 }, { now: SITREP_NOW, from: checked.value.from });
  expect(outcome.ok).toBe(true);
});

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); restore?.(); restore = undefined;
  setSystemTime();
});

function sourceFor(record: Record<string, unknown>): HomeFeedSource {
  const entry: HomeFeedEntry = {
    source: { sourceId: "grant-agent", agentDid: "did:key:grant-publisher", label: "Halvard", output: { spaceId: "grant-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_grant" }, responses: { spaceId: "grant-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_grant" } },
    state: {
      card: { cardId: `grant-${String(record.id)}`, revision: 1, issuanceId: "grant-issuance", kind: "approval", needsResponse: true, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt), payload: { sitrep: { version: 1, record } } },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "grant-agent", cardId: `grant-${String(record.id)}`, revision: 1, issuanceId: "grant-issuance" },
  };
  const snapshot: HomeFeedSnapshot = { entries: [entry], settings: { defaultSelector: "both" } };
  const owner = { answers: [], states: [], claimDecisions: [], threads: [], deliveries: [], heldNotes: [] };
  const refuse = async () => { throw new Error("The test only reads the card"); };
  return {
    async load() { return Object.assign(structuredClone(snapshot), { sitrep: structuredClone(owner) }); },
    saveResponse: refuse, sendMessage: refuse, saveOwnerState: refuse, saveHeldNote: refuse, snooze: refuse,
    async markSeen() {}, async setDefaultSelector() {}, subscribe() { return () => {}; },
  };
}

test("Home draws all 20 names of a read grant on the open card, before the link that approves it", async () => {
  setSystemTime(new Date(SITREP_NOW));
  const names = namesOf(20);
  const checked = validateRecord("approval", readGrant(20, { status: "open", issuedAt: SITREP_NOW, copiedNames: names.slice(0, 3), keepNames: names.slice(10) }));
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={sourceFor(checked.value as unknown as Record<string, unknown>)} />));
  // Open the card in place, as a reader would: an answered one waits in Pending; the rest are rows. Details stay shut.
  const pending = host.querySelector<HTMLButtonElement>('section[aria-label="Pending"] > button[aria-expanded="false"]');
  if (pending) await act(async () => pending.click());
  const row = () => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((item) => !item.querySelector("article"))
    .map((item) => item.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')).find(Boolean) ?? null;
  for (let next = row(); next; next = row()) await act(async () => next!.click());
  const article = [...host.querySelectorAll<HTMLElement>("article")].find((node) => [...node.children].some((child) => child.tagName === "H2" && child.textContent === checked.value.title));
  if (!article) throw new Error("The grant card is not open on Home");
  const listed = [...article.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Names: "));
  expect(listed?.textContent).toBe(`Names: ${names.join(", ")}`);
  expect([...article.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Already copied: "))?.textContent).toBe(`Already copied: ${names.slice(0, 3).join(", ")}`);
  expect([...article.querySelectorAll("p")].find((node) => node.textContent?.startsWith("Also retained: "))?.textContent).toBe(`Also retained: ${names.slice(10).join(", ")}`);
  const review = [...article.querySelectorAll("a[href]")].find((node) => node.textContent?.includes("Review in OpenKey"));
  expect(review !== undefined).toBe(true);
  expect(Boolean(listed!.compareDocumentPosition(review!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
});
