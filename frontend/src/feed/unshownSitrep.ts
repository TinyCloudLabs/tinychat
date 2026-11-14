// What the open typed card (SitrepCard.tsx and everything it renders: the header's title, body and time, the context
// panel, each kind's own rows, the links and the Details pop-up's Agent, Type and Reference) draws of each record kind.
// Every key not named here is listed under "Not shown on the card", exactly as sent. When SitrepCard starts drawing a
// field (or stops), update its kind's shape here: unshownSitrep.test.tsx renders one fully filled card per kind through
// the real UI and fails when a field the shape leaves out appears on the card, or one it names does not.
import { linkify, type BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { Shape } from "./unshown";

type Fields = Readonly<Record<string, Shape>>;

/**
 * Drawn on every kind: the title, body and posting time in the card's header (the publisher copies them from the
 * record), `from` as the author and Details' Agent, the id as Details' Reference, `status` in Details' Type, "Holds
 * up" for `blocks`, and the links (each label with its host, the URL as the link). Never drawn on any kind: `owner`
 * (except as a progress card's updater, below), `urgency`, `importance`, `updatedAt` (except on progress) and `closedAt`.
 */
const drawn = { kind: true, id: true, title: true, body: true, from: true, createdAt: true, status: true, blocks: true, links: { "[]": { label: true, url: true } } } as const;

/** The shaded context panel; `related` as "Earlier questions". */
const context = { context: { background: true, whyNow: true, ifNoAnswer: true, known: true, related: true } } as const;

/**
 * Asks, tasks and approvals: the context panel, `repo` (only through a bare #123 in the context, see `repoDrawn`), the
 * officer's priority reason in Details' Type (its `by` and `at` are not drawn) and `unblockedBy` as "Waiting on".
 * `group` is not drawn: it heads a group of two or more cards in the list, never the card itself.
 */
const brief = { ...context, repo: true, priority: { reason: true }, unblockedBy: true } as const;

const SHAPES: Readonly<Record<BoardRecord["kind"], Fields>> = {
  // Not drawn: askedAt, lastAskedAt, expiredAt, expiryBaseAt, resubmitOf, resubmitCount, supersededBy, mode, group.
  // recommend as the Suggested tag and "Accept recommendation"; default and decideBy in the "goes ahead" lines.
  ask: { ...drawn, ...brief, deadline: true, expiresAt: true, options: { "[]": { id: true, label: true, detail: true, cost: true } }, recommend: true, default: true, decideBy: true, proceededAt: true },
  // Not drawn: expiredAt, expiryBaseAt, resubmitOf, resubmitCount, group. expiresAt as "Legacy expiry".
  task: { ...drawn, ...brief, deadline: true, expiresAt: true, steps: { "[]": { id: true, text: true } }, chatLink: true },
  // Not drawn: deadline, urgencyRaisedAt, name (only `names` is listed), wholeScopeApprovedBy, grantMode, partOf, group.
  // forAsk folds the approval into its ask's card, where skipOn marks it not needed.
  approval: { ...drawn, ...brief, approvalType: true, approvalKind: true, url: true, issuedAt: true, expiresAt: true, permissions: true, names: true, copiedNames: true, keepNames: true,
    steps: true, profile: true, target: true, codeExpected: true, scope: true, scopeGrant: true, nameWhy: { "[]": { name: true, why: true } }, warning: true, forAsk: true },
  incident: { ...drawn, severity: true, impact: true, startedAt: true, resolvedAt: true },
  // Not drawn: askIds (the card only says to answer its questions on their own cards), standing.
  work: { ...drawn, next: true, waitsOn: true },
  ship: { ...drawn, at: true, component: true, version: true, prevVersion: true },
  order: { ...drawn, at: true, source: true, verbatim: true, appliesTo: true },
  // makeTrue.effort only beside its tickets (see `sitrepRecordShape`).
  claim: { ...drawn, site: true, url: true, quote: true, location: true, trueToday: true, evidence: { "[]": { label: true, ref: true } }, makeTrue: { tc: true, effort: true }, severity: true },
  // Not drawn: owner, decidedBy, decidedAt, liftedBy, and a cleared blocker's time and reason (only " · Cleared").
  hold: { ...drawn, what: true, samWords: true, cause: true, exit: true, expectedRelease: true, releasedBy: true, unblockedBy: true, unblockedByMode: true,
    clearedRefs: { "[]": { ref: true, by: true } }, liftedAt: true, liftReason: true },
  // Not drawn: updaters, important; owner only when no updatedBy names the updater (see `sitrepRecordShape`).
  progress: { ...drawn, ticket: true, steps: { "[]": { name: true, state: true } }, currentStep: true, eta: true, note: true, updatedBy: true, updatedAt: true },
};

/** What the open typed card draws of each record kind, for the usual record of that kind; `sitrepRecordShape` refines it. */
export const SITREP_RECORD_SHAPES: Readonly<Record<BoardRecord["kind"], Shape>> = SHAPES;

/** A record's `repo` is drawn only as the link target of a bare #123 in its context panel. */
function repoDrawn(record: BoardRecord): boolean {
  if (!("context" in record) || !record.repo) return false;
  const { background, whyNow, ifNoAnswer, known } = record.context;
  return [background, whyNow, ifNoAnswer, ...known].some((text) => !!text && linkify(text, record.repo).some((part) => "href" in part && part.label.startsWith("#")));
}

/**
 * What the open card draws of this record: its kind's shape, less what this record's own content keeps off the card.
 * A repo no bare #123 refers to is not drawn; a claim's effort shows only beside its tickets; a progress card names
 * its owner as the updater when no `updatedBy` is given.
 */
export function sitrepRecordShape(record: BoardRecord): Shape {
  const shape: Record<string, Shape> = { ...SHAPES[record.kind] };
  if ("repo" in shape && !repoDrawn(record)) delete shape.repo;
  if (record.kind === "claim" && !record.makeTrue.tc?.length) shape.makeTrue = { tc: true };
  if (record.kind === "progress" && !record.updatedBy) shape.owner = true;
  return shape;
}
