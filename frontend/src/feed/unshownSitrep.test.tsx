// The oracle for unshownSitrep.ts is the real renderer: one open card per record kind (and per variant that changes
// what the card draws), every optional field filled with distinctive words, rendered through the real Home UI with its
// Details open. Every text leaf the kind's shape names must be on the card; every one it leaves out must not be. A
// field SitrepCard starts (or stops) drawing fails here until its shape is updated.
import { afterEach, expect, mock, setSystemTime, test } from "bun:test";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { validateRecord, type BoardRecord, type Kind } from "@tinyboilerplate/core/feed/sitrep";
import { installDom } from "@/test/dom";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource } from "./feedStoreTypes";
import { SITREP_NOW } from "./sitrep.fixtures";
import { shortTime } from "./ShortTime";
import { unshownFields, type Shape } from "./unshown";
import { sitrepRecordShape, SITREP_RECORD_SHAPES } from "./unshownSitrep";

// Radix portals do not attach in happy-dom: the sheet's chrome is an inline stand-in, as in SitrepFeed.test.tsx. The
// Home UI is imported after the mock is registered, so its import has to be dynamic.
mock.module("../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog" aria-label="sheet"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { FeedViewEntries } = await import("./FeedView");

const NOW = Date.parse(SITREP_NOW);
/** A time `minutes` from now. Every time in one record is a different minute, so no two can be mistaken. */
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

const CONTEXT = {
  background: "The zephyr ledger migration moves the quarterly basalt invoices onto the new marigold storage tier before the freeze.",
  whyNow: "The marigold tier window closes when the regional freeze begins.",
  ifNoAnswer: "The migration waits and the basalt invoices stay on the old tier.",
  known: ["The dry run in #4821 copied every invoice without a mismatch.", "Finance signed off the tier pricing last Thursday."],
  related: ["ask-earlier-ferry", "ask-earlier-lantern"],
};
/** The same context with no bare #123: the record's repo is then drawn nowhere. */
const CONTEXT_NO_REF = { ...CONTEXT, known: ["The dry run copied every invoice without a mismatch."] };

/** Fields every kind carries, with words no other field uses. */
const common = (kind: Kind, id: string, title: string) => ({
  kind, id, title, body: `The ${title.toLowerCase()} body says what changed.`,
  from: "Halvard", owner: "Thaddeus Quorne", urgency: 3, importance: 4,
  links: [{ label: "Runbook quillwort", url: "https://runbooks.example.test/quillwort" }],
  repo: "tinycloudlabs/zephyr-ledger", blocks: "the vellum cutover",
  createdAt: at(-1441), updatedAt: at(-1381), closedAt: at(-1323),
});
const priority = { by: "officer", reason: "blocks the basalt ferry release", at: at(-1097) };

interface Variant {
  name: string;
  record: Record<string, unknown>;
  /** Shown leaves this variant's card does not draw, by path, and why; the shape is right for the usual card. */
  conditional?: Readonly<Record<string, string>>;
}

const ask = {
  ...common("ask", "ask-zephyr-tier", "Pick the marigold tier plan"), priority, context: CONTEXT,
  expiresAt: at(14411), resubmitOf: "ask-ochre-original", resubmitCount: 2, expiryBaseAt: at(-1151), unblockedBy: ["task:zephyr-prereq", "TC-4093"],
  deadline: at(1453), recommend: "careful", askedAt: at(-1267), lastAskedAt: at(-1213), status: "open", supersededBy: "ask-umber-successor",
  options: [{ id: "quick", label: "Move every invoice tonight", detail: "Fastest, with a short read outage.", cost: "About forty minutes of downtime" },
    { id: "careful", label: "Move them in nightly batches (Recommended)", detail: "No outage; finishes over a week.", cost: "Seven nightly windows" }],
  mode: "proceeding", default: "quick", decideBy: at(127), group: "Basalt lantern group",
};

const VARIANTS: readonly Variant[] = [
  { name: "ask, proceeding, window open", record: ask },
  { name: "ask, proceeding, gone ahead", record: { ...ask, proceededAt: at(-37) }, conditional: { decideBy: "once it has gone ahead the card says so, not when the window closed" } },
  { name: "ask, blocking, no #ref for its repo", record: { ...ask, context: CONTEXT_NO_REF, mode: "blocking", default: undefined, decideBy: undefined } },
  { name: "task", record: {
    ...common("task", "task-zephyr-prep", "Prepare the marigold tier"), priority, context: CONTEXT, status: "todo",
    steps: [{ id: "export", text: "Export the basalt invoice index" }, { id: "verify", text: "Compare the checksum report" }], deadline: at(1453), chatLink: "https://chat.example.test/zephyr-prep",
    expiresAt: at(14411), resubmitOf: "task-ochre-original", resubmitCount: 1, expiryBaseAt: at(-1151), unblockedBy: ["ask:zephyr-tier"], group: "Basalt lantern group",
  } },
  { name: "approval, go", record: {
    ...common("approval", "approval-zephyr-go", "Release the marigold deploy"), priority, context: CONTEXT, status: "open",
    approvalType: "go", approvalKind: "deploy", issuedAt: at(-61), expiresAt: at(4327), deadline: at(2203), urgencyRaisedAt: at(-89),
    permissions: "Deploys the zephyr ledger build to the marigold cluster.", steps: ["Read the release notes", "Check the canary dashboard"],
    profile: "roci-zephyr", target: "Marisol lab seat", codeExpected: false, unblockedBy: ["TC-4093"], group: "Basalt lantern group",
  } },
  { name: "approval, secret request", record: {
    ...common("approval", "approval-zephyr-secret", "Add the nebula credential"), context: CONTEXT, status: "open",
    approvalType: "secret", url: "https://secrets.tinycloud.xyz/request?req=zr-8841", name: "QUASAR_TOKEN", scope: "software-factory",
    issuedAt: at(-61), expiresAt: at(4327), forAsk: { id: "ask-cobalt-parent", skipOn: ["skip-cobalt"] },
  } },
  { name: "approval, whole-scope read grant", record: {
    ...common("approval", "approval-zephyr-grant", "Grant the zephyr read keys"), context: CONTEXT, status: "open",
    approvalType: "openkey", url: "https://openkey.so/delegate?grant=zephyr-read", codeExpected: true, issuedAt: at(-61), expiresAt: at(4327),
    names: ["ZEPHYR_READ_KEY", "LANTERN_API_KEY", "ORCHID_SIGNING_KEY"], copiedNames: ["ZEPHYR_READ_KEY"], keepNames: ["ORCHID_SIGNING_KEY"],
    scope: "software-factory", scopeGrant: "all", wholeScopeApprovedBy: "ask-cinnabar-scope", partOf: "approval-zephyr-secret",
  } },
  { name: "approval, write grant", record: {
    ...common("approval", "approval-quince-rotate", "Let roci rotate the quince key"), context: CONTEXT, status: "open",
    approvalType: "openkey", url: "https://openkey.so/delegate?grant=quince-rotate", grantMode: "write", scope: "vault-quince", issuedAt: at(-61),
    names: ["QUINCE_SIGNING_KEY"], nameWhy: [{ name: "QUINCE_SIGNING_KEY", why: "Rotates the quince signing material every Sunday." }],
    warning: "Approving lets roci overwrite the live quince key.",
  } },
  { name: "incident", record: {
    ...common("incident", "incident-zephyr", "Marigold reads are slow"), status: "mitigated", severity: "sev1",
    impact: "Invoice pages take nine seconds to open.", startedAt: at(-517), resolvedAt: at(-73),
  } },
  { name: "work", record: {
    ...common("work", "work-zephyr", "Zephyr ledger migration"), status: "blocked", next: "Copy the third basalt batch",
    waitsOn: "The marigold quota increase", askIds: ["ask-saffron-one"], standing: true,
  } },
  { name: "ship", record: { ...common("ship", "ship-zephyr", "Zephyr ledger release"), component: "ledger-api", version: "7.4.1-heron", prevVersion: "7.3.9-egret", at: at(-211), status: "rolled-back" } },
  { name: "order", record: {
    ...common("order", "order-zephyr", "Keep invoices on two tiers"), at: at(-307), source: "relay:Naomi",
    verbatim: "Never delete an invoice copy until both tiers agree on its checksum.", appliesTo: "Every ledger migration", status: "active",
  } },
  { name: "claim, with tickets", record: {
    ...common("claim", "Q-417", "Claim about the ledger"), status: "open", site: "Tinycloud homepage", url: "https://claims.example.test/homepage",
    quote: "Invoices move between tiers with zero downtime.", location: "Pricing page, third bullet", trueToday: "Moves pause reads for about forty seconds.",
    evidence: [{ label: "Downtime graph", ref: "https://grafana.example.test/d/heron" }, { label: "Copy loop", ref: "src/ledger/copy.ts:42" }],
    makeTrue: { tc: ["TC-4471"], effort: "Two weeks of dual-write work" }, severity: "high",
  } },
  { name: "claim, effort with no ticket", record: {
    ...common("claim", "Q-418", "Second claim about the ledger"), status: "open", site: "Tinycloud docs", url: "https://claims.example.test/docs",
    quote: "Every invoice is replicated thrice.", location: "Storage guide, opening line", trueToday: "Invoices are replicated twice.",
    evidence: [{ label: "Replica audit", ref: "https://audit.example.test/replicas" }], makeTrue: { effort: "Add a third marigold replica" }, severity: "low",
  } },
  { name: "hold, active", record: {
    ...common("hold", "hold-zephyr", "Pause the invoice move"), status: "active", what: "The basalt invoice copy job", decidedBy: "Commander Ilse Varga", decidedAt: at(-613),
    samWords: "Stop the copy until the checksums agree.", cause: "Two invoice checksums disagree.", exit: "Both tiers report identical checksums.",
    expectedRelease: "after the upstream marble patch ships", releasedBy: "upstream", unblockedBy: ["task:marble-prep", "TC-5120"], unblockedByMode: "any",
    clearedRefs: [{ ref: "TC-5120", by: "sam", at: at(-151), reason: "The marble ticket closed upstream" }],
  } },
  { name: "hold, lifted", record: {
    ...common("hold", "hold-zephyr-lifted", "Pause the heron export"), status: "lifted", what: "The heron export job", cause: "The export target was full.",
    exit: "The export target has room.", releasedBy: "engineering", liftedAt: at(-29), liftReason: "The target volume was doubled.", liftedBy: "Rowan Teale",
  } },
  { name: "progress, with updater", record: {
    ...common("progress", "progress-zephyr", "Zephyr ledger rollout"), owner: "Perpetua Lind", ticket: "TC-6230",
    steps: [{ name: "Build the copier", state: "live" }, { name: "Review the copier", state: "in-progress" }], currentStep: 1, eta: at(3011),
    note: "Review waits on the storage lead.", updatedBy: "Oswin Hale", important: true, status: "open", updaters: ["00000000-0000-4000-8000-00000000c0de"], closedAt: undefined,
  } },
  { name: "progress, owner as updater", record: {
    ...common("progress", "progress-heron", "Heron export rollout"), owner: "Perpetua Lind", ticket: "TC-6231",
    steps: [{ name: "Plan the export", state: "review" }], currentStep: 0, important: false, status: "open", closedAt: undefined,
  } },
];

/**
 * Shown leaves drawn as something else, never as their own text: option ids as their labels, scopeGrant as "Whole-scope
 * grant", and bookkeeping (the fold into an ask, the constant "sam" on a cleared blocker).
 */
function drawnOtherwise(path: string): boolean {
  return path === "kind" || path === "recommend" || path === "default" || path === "scopeGrant" || /^(?:options|steps)\[\d+\]\.id$/.test(path) || path.startsWith("forAsk.") || /^clearedRefs\[\d+\]\.by$/.test(path);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MONTH = new Intl.DateTimeFormat("en-GB", { month: "short" });
/** SitrepCard's medium time ("13 Nov, 09:00"). */
function stamp(value: string) {
  const date = new Date(value);
  const year = date.getFullYear() === new Date().getFullYear() ? "" : ` ${date.getFullYear()}`;
  return `${date.getDate()} ${MONTH.format(date)}${year}, ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
/** Lowercase words: "(Recommended)" off an option label, everything but letters and digits a single space, padded. */
const words = (value: string) => ` ${value.replace(/\s*\(recommended\)\s*$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

interface Leaf { path: string; value: string; shown: boolean }
const isList = (shape: Shape): shape is { readonly "[]": Shape } => typeof shape === "object" && "[]" in shape;
/** Every text leaf of `value`, and whether `shape` (undefined: not drawn) draws it, as unshownFields reads shapes. */
function leaves(value: unknown, shape: Shape | undefined, path: string, into: Leaf[]): Leaf[] {
  const inner = (key: string | number) => shape === undefined || shape === true ? shape
    : typeof key === "number" ? (isList(shape) ? shape["[]"] : undefined)
      : !isList(shape) && Object.hasOwn(shape, key) ? (shape as Record<string, Shape>)[key] : undefined;
  if (Array.isArray(value)) value.forEach((item, index) => leaves(item, inner(index), `${path}[${index}]`, into));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) leaves(item, Array.isArray(value) ? undefined : inner(key), path ? `${path}.${key}` : key, into);
  else if (typeof value === "string" && value) into.push({ path, value, shown: shape === true });
  return into;
}

let restore: (() => void) | undefined;
const roots = new Set<Root>();
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear(); restore?.(); restore = undefined;
  setSystemTime();
});

function sourceFor(record: Record<string, unknown>): HomeFeedSource {
  const needsResponse = !["incident", "work", "ship", "order", "progress"].includes(String(record.kind));
  const entry: HomeFeedEntry = {
    source: { sourceId: "oracle-agent", agentDid: "did:key:oracle-publisher", label: "Halvard", output: { spaceId: "oracle-owner", database: "xyz.tinycloud.tinychat/feed/feed_output_oracle" }, responses: { spaceId: "oracle-owner", database: "xyz.tinycloud.tinychat/feed/feed_responses_oracle" } },
    state: {
      // As the publisher (scripts/home-feed/inventory.ts) writes it: the card's title, body and time are the record's.
      card: { cardId: `oracle-${String(record.id)}`, revision: 1, issuanceId: "oracle-issuance", kind: String(record.kind), needsResponse, title: String(record.title), body: String(record.body), urgency: 2, createdAt: String(record.createdAt), payload: { sitrep: { version: 1, record } } },
      response: null, acknowledgement: null, outcome: null,
    },
    view: { sourceId: "oracle-agent", cardId: `oracle-${String(record.id)}`, revision: 1, issuanceId: "oracle-issuance" },
  };
  const snapshot: HomeFeedSnapshot = { entries: [entry], settings: { defaultSelector: "both" } };
  const owner = { answers: [], states: [], claimDecisions: [], threads: [], deliveries: [], heldNotes: [] };
  const refuse = async () => { throw new Error("The oracle only reads the card"); };
  return {
    async load() { return Object.assign(structuredClone(snapshot), { sitrep: structuredClone(owner) }); },
    saveResponse: refuse, sendMessage: refuse, saveOwnerState: refuse, saveHeldNote: refuse, snooze: refuse,
    async markSeen() {}, async setDefaultSelector() {}, subscribe() { return () => {}; },
  };
}

/** The open card, Details unfolded: its words (text nodes apart), link targets and machine times, less Details' own lists of the card's data. */
async function openCard(record: Record<string, unknown>) {
  restore ??= installDom();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host); roots.add(root);
  await act(async () => root.render(<FeedViewEntries realEntries={[]} source={sourceFor(record)} />));
  // Open the card in place: Needs you opens its first card itself; an answered one waits in Pending; the rest are rows.
  const pending = host.querySelector<HTMLButtonElement>('section[aria-label="Pending"] > button[aria-expanded="false"]');
  if (pending) await act(async () => pending.click());
  const row = () => [...host.querySelectorAll<HTMLElement>("li[data-card-key]")].filter((item) => !item.querySelector("article"))
    .map((item) => item.querySelector<HTMLButtonElement>('button[aria-expanded="false"]:not([aria-haspopup])')).find(Boolean) ?? null;
  for (let next = row(); next; next = row()) await act(async () => next!.click());
  const titled = () => [...host.querySelectorAll<HTMLElement>("article")].find((node) => [...node.children].some((child) => child.tagName === "H2" && child.textContent === record.title));
  // A record its agent closed (a rolled-back ship, a lifted hold) is in History, not the live feed.
  if (!titled()) {
    const history = host.querySelector<HTMLInputElement>('[role="radiogroup"][aria-label="Feed view"] input[value="history"]');
    expect(history !== null).toBe(true);
    await act(async () => history!.click());
    for (let next = row(); next; next = row()) await act(async () => next!.click());
  }
  const article = titled();
  expect(article !== undefined).toBe(true);
  const details = [...article!.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((node) => node.textContent?.trim().startsWith("Details"));
  expect(details !== undefined).toBe(true);
  await act(async () => details!.click());
  const card = article!.cloneNode(true) as HTMLElement;
  expect(card.querySelector('[aria-label="Details"] section[aria-label="This card"]') !== null).toBe(true);
  for (const node of card.querySelectorAll('section[aria-label="Not shown on the card"], section[aria-label="Card data"]')) node.remove();
  const texts: string[] = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.textContent ?? "");
  const hrefs = [...card.querySelectorAll("a[href]")].map((node) => node.getAttribute("href") ?? "");
  const times = new Set([...card.querySelectorAll("time[datetime]")].map((node) => node.getAttribute("datetime")));
  const text = words([...texts, ...hrefs].join(" "));
  return { text, times, has: (leaf: string) => ISO.test(leaf) ? times.has(leaf) || text.includes(words(stamp(leaf))) || text.includes(words(shortTime(leaf))) : text.includes(words(leaf)) };
}

test.each(VARIANTS.map((variant) => [variant.name, variant] as const))("%s: the card draws exactly what its shape names", async (_name, variant) => {
  setSystemTime(new Date(NOW));
  const record = JSON.parse(JSON.stringify(variant.record)) as Record<string, unknown>;
  const checked = validateRecord(record.kind as Kind, record);
  if (!checked.ok) throw new Error(`Invalid ${variant.name} fixture: ${checked.errors.join("; ")}`);
  const shape = sitrepRecordShape(checked.value);
  const card = await openCard(record);
  const all = leaves(record, shape, "", []);
  const missing = all.filter((leaf) => leaf.shown && !drawnOtherwise(leaf.path) && !variant.conditional?.[leaf.path] && !card.has(leaf.value)).map((leaf) => leaf.path);
  const drawnButUnlisted = all.filter((leaf) => !leaf.shown && card.has(leaf.value)).map((leaf) => leaf.path);
  expect({ missing, drawnButUnlisted }).toEqual({ missing: [], drawnButUnlisted: [] });
  // Each conditional leaf really is off this card, so its exemption is not hiding a drawn field.
  for (const path of Object.keys(variant.conditional ?? {})) expect(all.some((leaf) => leaf.path === path && leaf.shown && !card.has(leaf.value))).toBe(true);
});

test("every record kind has a shape and a variant", () => {
  expect(Object.keys(SITREP_RECORD_SHAPES).sort()).toEqual(["approval", "ask", "claim", "hold", "incident", "order", "progress", "ship", "task", "work"]);
  expect([...new Set(VARIANTS.map((variant) => variant.record.kind))].sort()).toEqual(Object.keys(SITREP_RECORD_SHAPES).sort());
});

test("an open ask lists its importance, mode, posting bookkeeping and group, and draws its recommendation, default and window", async () => {
  setSystemTime(new Date(NOW));
  const checked = validateRecord("ask", ask);
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const unshown = unshownFields(ask, sitrepRecordShape(checked.value as BoardRecord)).map((field) => field.path);
  expect(unshown).toEqual(expect.arrayContaining(["owner", "urgency", "importance", "updatedAt", "closedAt", "priority.by", "priority.at", "resubmitOf", "resubmitCount", "expiryBaseAt", "askedAt", "lastAskedAt", "supersededBy", "mode", "group"]));
  for (const drawn of ["status", "createdAt", "repo", "recommend", "default", "decideBy", "deadline", "expiresAt"]) expect(unshown).not.toContain(drawn);
  const card = await openCard(JSON.parse(JSON.stringify(ask)) as Record<string, unknown>);
  // The recommendation is the Suggested option; the default and window are the "goes ahead … at" line.
  expect(card.text).toContain(words("Move them in nightly batches Suggested"));
  expect(card.text).toContain(words(`Halvard goes ahead with Move every invoice tonight at ${stamp(ask.decideBy)} unless you choose`));
});
