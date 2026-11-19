// Dependencies: what waits on what, across asks, tasks, approvals and holds. One index per snapshot.
// An edge is stored on the dependent side only (its `unblockedBy`); the inverse ("Y unblocks X") is always derived.
// Semantics are AND: X is unblocked when every record it lists is closed as done. External refs (Linear, GitHub)
// are shown, never resolved. Pure functions over the board's records, shared by the CLI, the page and the tests.
import { type BoardRecord, type Hold, isClosed } from "./schema";

/** A card or hold waits on a record (ask, task, approval, hold) or on an external ref (Linear key, GitHub ref). */
export type DepTarget = { kind: "ask" | "task" | "approval" | "hold"; id: string } | { kind: "external"; ref: string };

export function parseDepRef(ref: string): DepTarget {
  const match = /^(ask|task|approval|hold):(.+)$/.exec(ref);
  return match ? { kind: match[1] as "ask" | "task" | "approval" | "hold", id: match[2]! } : { kind: "external", ref };
}

/** The key two refs share when they name the same record: "task:abc". */
export const refKey = (kind: string, id: string): string => `${kind}:${id}`;

export const isHold = (record: BoardRecord): record is Hold => record.kind === "hold";
export const activeHolds = (records: readonly BoardRecord[]): Hold[] => records.filter(isHold).filter((hold) => hold.status === "active");

/** "any": a hold whose unblockedBy are alternatives (it lifts when one is done). Everything else, and every card, is "all". */
export const edgeMode = (record: BoardRecord): "all" | "any" => (record.kind === "hold" && record.unblockedByMode === "any" ? "any" : "all");

/** The edge list of a record that can carry one: asks, tasks, approvals and holds. */
export function edgesOf(record: BoardRecord): readonly string[] {
  return record.kind === "ask" || record.kind === "task" || record.kind === "approval" || record.kind === "hold" ? (record.unblockedBy ?? []) : [];
}

/** Longest chain an "Unblocks" line follows: a card, what it frees, what those free, and one more. */
export const UNBLOCK_DEPTH = 3;
/** Hops a ref follows from an expired or superseded card to the card that replaced it. */
export const FORWARD_HOPS = 5;
/** A dependent that closed this recently still shows (as done) in a chain. */
export const CLOSED_SHOWN_MS = 24 * 3_600_000;

/**
 * Production or security, as whole words: "prod", "production", "security". A hyphen or apostrophe
 * on either side joins the word to something else, so "pre-prod", "non-prod", "production-like" and
 * "prod's" do not count, nor does "product" or "insecurity". Only for dependency weight: the Waiting list's own
 * `blocks` rule (board.ts) keeps its plain whole-word match, so "security-fix release" and "prod-down" still lead it.
 */
export const HOLD_PROD_OR_SECURITY = /(?<![\w'’-])(?:prod|production|security)(?![\w'’-])/i;

export const holdIsCritical = (hold: Hold): boolean => [hold.what, hold.cause, hold.blocks].some((text) => text !== undefined && HOLD_PROD_OR_SECURITY.test(text));

/** A node weighs more when it names production or security (a hold by its text; a card by `blocks`) or is Sam's go on a release or deploy. */
export function isCriticalNode(record: BoardRecord): boolean {
  if (record.kind === "hold") return holdIsCritical(record);
  if (record.kind === "approval" && record.approvalType === "go" && (record.approvalKind === "release" || record.approvalKind === "deploy")) return true;
  return "blocks" in record && record.blocks !== undefined && HOLD_PROD_OR_SECURITY.test(record.blocks);
}

// ── The index ────────────────────────────────────────────────────────

/** missing: a record ref that is not on the board. external: a Linear or GitHub ref, never resolved. */
export type DepState = "open" | "done" | "closed-not-done" | "missing" | "external";

/** Who must act for a node to close. */
export type DepActor =
  | { who: "you" }
  | { who: "officer"; name: string; /** What they are doing: "to close it", "your call", "goes ahead at …". */ note?: string }
  /** A hold Sam releases, but its own blockers are not cleared yet: nobody can lift it. `on` names who acts first ("you", an officer, "external"). */
  | { who: "waiting"; on: string[] }
  | { who: "external" }
  | { who: "none" };

/** What the page knows that the records do not say. */
export interface DepContext {
  /** refKeys of the cards on Sam's list (waiting or snoozed, parts of a combined ask included): his to act on. */
  waitingOnSam?: ReadonlySet<string>;
  /** refKeys of the cards whose priority is on (Sam's or an officer's). */
  priorityOn?: ReadonlySet<string>;
}

/** Statuses that count as finished: what the dependent waited for happened. Every other closed status never will. */
const DONE_STATUSES: readonly string[] = ["answered", "done", "lifted"];

export function depStateOf(record: BoardRecord): "open" | "done" | "closed-not-done" {
  if (!isClosed(record)) return "open";
  return DONE_STATUSES.includes(record.status) ? "done" : "closed-not-done";
}

/** A hold's blocker Sam cleared (hold.clearedRefs) counts as done, in "all" and "any" mode alike; every other entry is as resolved. */
export function markCleared(record: BoardRecord, entry: ResolvedRef): ResolvedRef {
  if (record.kind !== "hold" || entry.state === "done" || !record.clearedRefs?.some((cleared) => cleared.ref === entry.ref)) return entry;
  return { ...entry, state: "done", cleared: true };
}

/** Sam can move this blocker himself: it is his, or a hold that waits only on cards of his. */
const samCanClear = (entry: ResolvedRef): boolean => entry.state === "open" && (entry.actor.who === "you" || (entry.actor.who === "waiting" && entry.actor.on.length > 0 && entry.actor.on.every((name) => name === "you")));

/**
 * Whose turn a record is. A hold Sam releases is his only once what it waits on is cleared (every blocker done, or any
 * one for an alternatives hold): until then it is "waiting" on the actors of its open blockers. Pass the graph so the
 * blockers can be resolved; without it a hold with edges is "waiting" on nobody in particular, never "you".
 */
export function actorOf(record: BoardRecord, ctx: DepContext = {}, graph?: Pick<DepGraph, "resolve">): DepActor {
  if (isClosed(record)) return { who: "none" };
  if (record.kind === "hold") {
    if (record.releasedBy !== "sam") return { who: "officer", name: record.owner };
    if (!record.unblockedBy.length) return { who: "you" };
    const entries = graph ? record.unblockedBy.map((ref) => markCleared(record, graph.resolve(ref))) : undefined;
    if (entries && blockersCleared(record, entries)) return { who: "you" };
    // Alternatives: any one will do, so an option Sam can clear himself is all he waits on (the officers' options are not in his way).
    if (entries && edgeMode(record) === "any" && entries.some(samCanClear)) return { who: "waiting", on: ["you"] };
    const on = new Set<string>();
    for (const entry of entries ?? []) {
      if (entry.state === "external") on.add("external");
      if (entry.state !== "open") continue;
      if (entry.actor.who === "you") on.add("you");
      else if (entry.actor.who === "officer") on.add(entry.actor.name);
      else if (entry.actor.who === "waiting") entry.actor.on.forEach((name) => on.add(name));
    }
    return { who: "waiting", on: [...on] };
  }
  if (record.kind !== "ask" && record.kind !== "task" && record.kind !== "approval") return { who: "none" };
  if (ctx.waitingOnSam?.has(refKey(record.kind, record.id))) return { who: "you" };
  if (record.kind === "ask" && record.mode === "proceeding") return { who: "officer", name: record.from, note: record.decideBy ? `goes ahead at ${record.decideBy}` : "goes ahead" };
  return { who: "officer", name: record.from, note: "to close it" };
}

export const depTitle = (record: BoardRecord): string => (record.kind === "hold" ? record.what : record.title);

export interface ResolvedRef {
  /** The ref as written. */
  ref: string;
  /** The record's key, when the ref names one (after following a resubmit or supersede). */
  key?: string;
  record?: BoardRecord;
  state: DepState;
  actor: DepActor;
  title: string;
  /** The ref named an expired or superseded card; `record` is its newest successor. */
  forwarded?: boolean;
  /** Sam marked this blocker of a hold cleared: `state` is "done" though the record is not. */
  cleared?: boolean;
}

export interface ChainNode {
  key: string;
  kind: "ask" | "task" | "approval" | "hold";
  id: string;
  title: string;
  /** done: closed as done, kept because something open lies beyond it or it closed recently. */
  state: "open" | "done";
  /** Open nodes in this subtree, this one included, +3 each that is critical. Closed nodes weigh nothing. */
  weight: number;
  children: ChainNode[];
}

export interface DepGraph {
  /** What a record waits on, one entry per ref in `unblockedBy`. */
  blockersOf(kind: string, id: string): ResolvedRef[];
  /** The keys of the records whose `unblockedBy` names this one (successors followed), closed ones included. */
  dependentsOf(kind: string, id: string): string[];
  record(key: string): BoardRecord | undefined;
  resolve(ref: string): ResolvedRef;
  ctx: DepContext;
}

function closedAtOf(record: BoardRecord): number {
  const iso = record.kind === "hold" ? (record.liftedAt ?? record.updatedAt) : record.updatedAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/** The record that replaced an expired (resubmit) or superseded ask, if any. */
function successorKey(record: BoardRecord, resubmits: ReadonlyMap<string, string>): string | undefined {
  if (record.kind === "ask" && record.status === "superseded" && record.supersededBy) return refKey("ask", record.supersededBy);
  if (record.kind === "ask" || record.kind === "task" || record.kind === "approval") return resubmits.get(refKey(record.kind, record.id));
  return undefined;
}

/** Build the index once per snapshot. Cycle-safe everywhere: every walk keeps a visited set. */
export function depGraph(records: readonly BoardRecord[], ctx: DepContext = {}): DepGraph {
  const byKey = new Map<string, BoardRecord>();
  for (const record of records) byKey.set(refKey(record.kind, record.id), record);
  // Old key -> the card that says it resubmits it (a different id; a same-id resubmit needs no forwarding).
  const resubmits = new Map<string, string>();
  for (const record of records) {
    if ((record.kind === "ask" || record.kind === "task") && record.resubmitOf && record.resubmitOf !== record.id) {
      resubmits.set(refKey(record.kind, record.resubmitOf), refKey(record.kind, record.id));
    }
  }
  const forward = (start: string): { key: string; forwarded: boolean } => {
    let key = start;
    const seen = new Set([key]);
    for (let hop = 0; hop < FORWARD_HOPS; hop++) {
      const record = byKey.get(key);
      if (!record || depStateOf(record) !== "closed-not-done") break;
      const next = successorKey(record, resubmits);
      if (!next || seen.has(next) || !byKey.has(next)) break;
      seen.add(next);
      key = next;
    }
    return { key, forwarded: key !== start };
  };

  const turns = new Map<string, DepActor>();
  const resolving = new Set<string>();
  const resolve = (ref: string): ResolvedRef => {
    const target = parseDepRef(ref);
    if (target.kind === "external") return { ref, state: "external", actor: { who: "external" }, title: ref };
    const { key, forwarded } = forward(refKey(target.kind, target.id));
    const record = byKey.get(key);
    if (!record) return { ref, key, state: "missing", actor: { who: "none" }, title: ref };
    let actor = turns.get(key);
    if (!actor) {
      // A hold waiting on itself through a loop is nobody's turn; the guard ends the recursion.
      actor = resolving.has(key) ? { who: "waiting", on: [] } : (resolving.add(key), actorOf(record, ctx, { resolve }));
      resolving.delete(key);
      turns.set(key, actor);
    }
    return { ref, key, record, state: depStateOf(record), actor, title: depTitle(record), ...(forwarded ? { forwarded } : {}) };
  };

  const blockers = new Map<string, ResolvedRef[]>();
  const dependents = new Map<string, string[]>();
  for (const record of records) {
    const refs = edgesOf(record);
    if (!refs.length) continue;
    const self = refKey(record.kind, record.id);
    const resolved = refs.map(resolve).map((entry) => markCleared(record, entry));
    blockers.set(self, resolved);
    for (const entry of resolved) {
      // A cleared blocker no longer holds this record up, so it does not list it as a dependent.
      if (!entry.key || entry.key === self || entry.cleared) continue;
      const list = dependents.get(entry.key) ?? [];
      if (!list.includes(self)) list.push(self);
      dependents.set(entry.key, list);
    }
  }
  return {
    blockersOf: (kind, id) => blockers.get(refKey(kind, id)) ?? [],
    dependentsOf: (kind, id) => dependents.get(refKey(kind, id)) ?? [],
    record: (key) => byKey.get(key),
    resolve,
    ctx,
  };
}

const sortKeys = (keys: readonly string[]): string[] => [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * What a card unblocks, as a tree: its dependents, theirs, and theirs, to UNBLOCK_DEPTH, each record once
 * (a diamond keeps its first place; a cycle ends). Open nodes always show. A closed-as-done dependent shows
 * as done when something open lies beyond it or it closed within a day; a dropped, cancelled or expired one is
 * left out with everything behind it. Children are ordered by subtree weight, then id.
 */
export function unblockChain(graph: DepGraph, kind: string, id: string, now: number): ChainNode[] {
  const self = refKey(kind, id);
  const seen = new Set<string>([self]);
  const build = (parentKind: string, parentId: string, depth: number): ChainNode[] => {
    if (depth > UNBLOCK_DEPTH) return [];
    const nodes: ChainNode[] = [];
    for (const key of sortKeys(graph.dependentsOf(parentKind, parentId))) {
      if (seen.has(key)) continue;
      const record = graph.record(key);
      if (!record || (record.kind !== "ask" && record.kind !== "task" && record.kind !== "approval" && record.kind !== "hold")) continue;
      const state = depStateOf(record);
      if (state === "closed-not-done") continue;
      seen.add(key);
      const children = build(record.kind, record.id, depth + 1);
      const childWeight = children.reduce((sum, child) => sum + child.weight, 0);
      if (state === "done" && !(childWeight > 0 || now - closedAtOf(record) < CLOSED_SHOWN_MS)) continue;
      const weight = state === "open" ? 1 + (isCriticalNode(record) ? 3 : 0) + childWeight : childWeight;
      nodes.push({ key, kind: record.kind, id: record.id, title: depTitle(record), state, weight, children });
    }
    return nodes.sort((a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };
  return build(kind, id, 1);
}

/** The heaviest path down a chain tree: the one line a collapsed card shows. */
export function primaryPath(roots: readonly ChainNode[]): ChainNode[] {
  const path: ChainNode[] = [];
  for (let level = roots; level.length; level = level[0]!.children) path.push(level[0]!);
  return path;
}

/** Every node of a chain tree. */
export const chainSize = (roots: readonly ChainNode[]): number => roots.reduce((sum, node) => sum + 1 + chainSize(node.children), 0);

/**
 * Open blockers upstream of a card (to UNBLOCK_DEPTH) that Sam has to act on first. Closed blockers end
 * the walk: they are done or never coming. The card itself is never its own answer.
 */
export function needsYouFirst(graph: DepGraph, kind: string, id: string): ResolvedRef[] {
  const self = refKey(kind, id);
  const seen = new Set<string>([self]);
  const out: ResolvedRef[] = [];
  let frontier = [{ kind, id }];
  for (let depth = 1; depth <= UNBLOCK_DEPTH && frontier.length; depth++) {
    const next: Array<{ kind: string; id: string }> = [];
    for (const node of frontier) {
      // Alternatives (an any-hold's list): none of them has to come first, so none is named.
      const holder = graph.record(refKey(node.kind, node.id));
      if (holder && edgeMode(holder) === "any") continue;
      for (const blocker of graph.blockersOf(node.kind, node.id)) {
        if (!blocker.record || !blocker.key || blocker.state !== "open" || seen.has(blocker.key)) continue;
        seen.add(blocker.key);
        if (blocker.actor.who === "you") out.push(blocker);
        next.push({ kind: blocker.record.kind, id: blocker.record.id });
      }
    }
    frontier = next;
  }
  return out;
}

/** The cards of Sam's behind a blocker he can clear: the blocker itself when it is his, else (a hold that waits only on him) the cards of his it waits on, to UNBLOCK_DEPTH. */
function youLeaves(graph: DepGraph, entry: ResolvedRef, depth = 1): ResolvedRef[] {
  if (entry.actor.who === "you") return [entry];
  if (!entry.record || entry.actor.who !== "waiting" || depth > UNBLOCK_DEPTH) return [];
  const inner = graph.blockersOf(entry.record.kind, entry.record.id).filter(samCanClear);
  // Alternatives inside: any one will do, but each of his is still an option he can take; an all-hold needs every one of his.
  return inner.flatMap((option) => youLeaves(graph, option, depth + 1));
}

/**
 * Sam's own options among alternatives: an any-hold (to UNBLOCK_DEPTH upstream of the card, or the hold itself) with none done
 * yet and at least one open option that is his. Any one will do, so with several the page says "either A or B"; with one it
 * names it. The officers' options are not listed: he is not asked to wait for them.
 */
export function eitherYouFirst(graph: DepGraph, kind: string, id: string): ResolvedRef[][] {
  const seen = new Set<string>([refKey(kind, id)]);
  const out: ResolvedRef[][] = [];
  let frontier = [{ kind, id }];
  for (let depth = 1; depth <= UNBLOCK_DEPTH && frontier.length; depth++) {
    const next: Array<{ kind: string; id: string }> = [];
    for (const node of frontier) {
      const holder = graph.record(refKey(node.kind, node.id));
      const entries = graph.blockersOf(node.kind, node.id);
      if (holder && edgeMode(holder) === "any") {
        const mine = entries.filter(samCanClear).flatMap((entry) => youLeaves(graph, entry));
        const unique = mine.filter((entry, index) => mine.findIndex((other) => other.key === entry.key) === index);
        if (unique.length && !entries.some((entry) => entry.state === "done")) out.push(unique);
        continue;
      }
      for (const blocker of entries) {
        if (!blocker.record || !blocker.key || blocker.state !== "open" || seen.has(blocker.key)) continue;
        seen.add(blocker.key);
        next.push({ kind: blocker.record.kind, id: blocker.record.id });
      }
    }
    frontier = next;
  }
  return out;
}

/** The open priority cards downstream (to UNBLOCK_DEPTH) of a card of Sam's: why it is needed for his priority. Empty on a card he has nothing to do on. */
export function neededForPriority(graph: DepGraph, kind: string, id: string, chain: readonly ChainNode[]): ChainNode[] {
  const self = graph.record(refKey(kind, id));
  const priorityOn = graph.ctx.priorityOn;
  if (!self || !priorityOn?.size || actorOf(self, graph.ctx, graph).who !== "you") return [];
  const out: ChainNode[] = [];
  const walk = (nodes: readonly ChainNode[]) => {
    for (const node of nodes) {
      if (node.state !== "open") continue;
      if (priorityOn.has(node.key)) out.push(node);
      walk(node.children);
    }
  };
  walk(chain);
  return out;
}

const dueOf = (record: BoardRecord): number | undefined => {
  let raw: string | undefined;
  if (record.kind === "hold") raw = record.expectedRelease && /^\d{4}-\d{2}-\d{2}T/.test(record.expectedRelease) ? record.expectedRelease : undefined;
  else if (record.kind === "ask" || record.kind === "task" || record.kind === "approval") raw = record.deadline;
  const ms = raw === undefined ? NaN : Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
};

/** The earliest deadline among the open dependents downstream of a card, and which one it is for. Display only. */
export function neededBy(graph: DepGraph, chain: readonly ChainNode[]): { at: number; title: string } | undefined {
  let best: { at: number; title: string } | undefined;
  const walk = (nodes: readonly ChainNode[]) => {
    for (const node of nodes) {
      const record = graph.record(node.key);
      const at = node.state === "open" && record ? dueOf(record) : undefined;
      if (at !== undefined && (!best || at < best.at)) best = { at, title: node.title };
      walk(node.children);
    }
  };
  walk(chain);
  return best;
}

export interface DepsCheck {
  /** Open records that list a record ref the board does not have. */
  dangling: Array<{ key: string; ref: string }>;
  /** Loops of edges, each as the keys around it, starting at the smallest. */
  cycles: string[][];
  /** Open records whose every record blocker is done: close or lift them. */
  unblocked: string[];
  /** Open records that wait on a blocker which closed without being done, so it will never unblock them. */
  neverComing: Array<{ key: string; ref: string; status: string }>;
}

/** `roci-board deps check`: the four ways an edge goes wrong. Reads only. */
export function depsCheck(records: readonly BoardRecord[], graph: DepGraph): DepsCheck {
  const out: DepsCheck = { dangling: [], cycles: [], unblocked: [], neverComing: [] };
  const withEdges = records.filter((record) => edgesOf(record).length);
  for (const record of withEdges) {
    if (isClosed(record)) continue;
    const key = refKey(record.kind, record.id);
    const blockers = graph.blockersOf(record.kind, record.id);
    for (const entry of blockers) {
      if (entry.state === "missing") out.dangling.push({ key, ref: entry.ref });
    }
    for (const entry of blockersNeverComing(record, blockers)) if (entry.record) out.neverComing.push({ key, ref: entry.ref, status: entry.record.status });
    if (blockersCleared(record, blockers)) out.unblocked.push(key);
  }
  // Depth-first over the edges; a back edge to a node on the path closes a loop.
  const state = new Map<string, "path" | "done">();
  const found = new Set<string>();
  const visit = (record: BoardRecord, path: string[]) => {
    const key = refKey(record.kind, record.id);
    state.set(key, "path");
    path.push(key);
    for (const entry of graph.blockersOf(record.kind, record.id)) {
      const next = entry.record;
      if (!entry.key || !next) continue;
      if (state.get(entry.key) === "path") {
        const loop = path.slice(path.indexOf(entry.key));
        const at = loop.indexOf([...loop].sort()[0]!);
        const rotated = [...loop.slice(at), ...loop.slice(0, at)];
        if (!found.has(rotated.join(">"))) {
          found.add(rotated.join(">"));
          out.cycles.push(rotated);
        }
      } else if (!state.has(entry.key)) visit(next, path);
    }
    path.pop();
    state.set(key, "done");
  };
  for (const record of withEdges) if (!state.has(refKey(record.kind, record.id))) visit(record, []);
  return out;
}

/** What finishing some cards frees: the open records downstream of them, transitively, and what that is worth. */
export interface Freed {
  /** refKeys of the open dependents (asks, tasks, approvals and active holds), each once, to UNBLOCK_DEPTH. Closed ones free nothing. */
  keys: string[];
  /** 1 per freed record, +3 for each that names production or security (isCriticalNode). */
  weight: number;
  /** How many of the freed records name production or security. */
  critical: number;
}

/**
 * The generalised unblock weight (every open dependent counts, not only holds). Several cards (an ask and
 * the parts folded into it) free the union of what each frees, each record once.
 */
export function freedBy(graph: DepGraph, cards: ReadonlyArray<{ kind: string; id: string }>, now: number): Freed {
  const keys = new Set<string>();
  // A record behind a finished one no longer waits on this card through it, so the walk goes on only through open ones.
  const walk = (nodes: readonly ChainNode[]) => {
    for (const node of nodes) {
      if (node.state !== "open") continue;
      // An alternatives hold that another alternative already cleared is lifted without this card: no credit.
      const target = graph.record(node.key);
      if (target && edgeMode(target) === "any" && blockersCleared(target, graph.blockersOf(target.kind, target.id))) continue;
      keys.add(node.key);
      walk(node.children);
    }
  };
  for (const card of cards) walk(unblockChain(graph, card.kind, card.id, now));
  const own = new Set(cards.map((card) => refKey(card.kind, card.id)));
  let weight = 0;
  let critical = 0;
  const freed: string[] = [];
  for (const key of keys) {
    const record = graph.record(key);
    if (!record || own.has(key)) continue;
    freed.push(key);
    const isCritical = isCriticalNode(record);
    weight += 1 + (isCritical ? 3 : 0);
    if (isCritical) critical += 1;
  }
  return { keys: freed, weight, critical };
}

/** An open card is a priority pin, or lifts one: it is upstream (to UNBLOCK_DEPTH) of an open pinned card. 2 = pinned itself, 1 = feeds a pin, 0 = neither. Sam's explicit "off" on the card wins over feeding. */
export function pinLevel(graph: DepGraph, kind: string, id: string, chain: readonly ChainNode[], samOff: ReadonlySet<string> = new Set()): 0 | 1 | 2 {
  const key = refKey(kind, id);
  const pins = graph.ctx.priorityOn;
  if (!pins?.size) return 0;
  if (pins.has(key)) return 2;
  if (samOff.has(key)) return 0;
  // Only through open nodes: a finished card in between no longer carries the wait.
  const feeds = (nodes: readonly ChainNode[]): boolean => nodes.some((node) => node.state === "open" && (pins.has(node.key) || feeds(node.children)));
  return feeds(chain) ? 1 : 0;
}

/**
 * True when the card waits on an open record whose turn is not Sam's: an officer (or something external) has to act first.
 * Names the first one. A hold that waits only on Sam's own cards does not count, nor does an alternatives hold with one of
 * his own options open: he can clear it himself. A hold waiting on external refs only, or caught in a loop, counts as "external".
 */
export function waitsOnOthers(graph: DepGraph, kind: string, id: string): { by: string; title: string } | undefined {
  for (const entry of graph.blockersOf(kind, id)) {
    if (entry.state !== "open" || !entry.record) continue;
    if (edgeMode(entry.record) === "any" && graph.blockersOf(entry.record.kind, entry.record.id).some(samCanClear)) continue;
    let by: string | undefined;
    if (entry.actor.who === "officer") by = entry.actor.name;
    else if (entry.actor.who === "waiting") by = entry.actor.on.find((name) => name !== "you" && name !== "external") ?? (entry.actor.on.includes("you") && !entry.actor.on.includes("external") ? undefined : "external");
    if (by !== undefined) return { by, title: entry.title };
  }
  return undefined;
}

// ── Upstream: what blocks a card, to the roots ───────────────────────

/** Depth of the "Blocked by" tree: a card's blockers, theirs, and so on, four levels. */
export const UPSTREAM_DEPTH = 4;

export interface UpNode {
  entry: ResolvedRef;
  /** What blocks this blocker, when it is open and has edges of its own. */
  below?: UpTree;
}

export interface UpTree {
  /** The nodes are alternatives (an any-hold's list): either … or. */
  any: boolean;
  nodes: UpNode[];
}

const upRank = (entry: ResolvedRef): number => {
  if (entry.state === "open") return entry.actor.who === "you" ? 0 : 1;
  return { external: 2, missing: 3, "closed-not-done": 4, done: 5, open: 1 }[entry.state];
};

/**
 * The full upstream of a card: its blockers, each blocker's blockers, to UPSTREAM_DEPTH. Sam's own items
 * come first at every level, then officers', external, missing, never-coming, done. Each record once
 * (a diamond keeps its first place; a cycle ends). `skip` keys are left out with everything behind them.
 */
export function upstreamTree(graph: DepGraph, kind: string, id: string, skip: ReadonlySet<string> = new Set(), depth = UPSTREAM_DEPTH): UpTree {
  // A record is walked into once; where it shows again (a diamond, or an alternative that is also needed elsewhere) it is a leaf, so an either/or group never loses an option. A record already on the path ends the walk (a cycle).
  const expanded = new Set<string>([refKey(kind, id), ...skip]);
  const build = (parentKind: string, parentId: string, level: number, path: ReadonlySet<string>): UpTree => {
    const parent = graph.record(refKey(parentKind, parentId));
    const entries = [...graph.blockersOf(parentKind, parentId)].sort((a, b) => upRank(a) - upRank(b));
    const nodes: UpNode[] = [];
    for (const entry of entries) {
      if (entry.key && (path.has(entry.key) || skip.has(entry.key))) continue;
      let below: UpTree | undefined;
      if (entry.record && entry.key && entry.state === "open" && level < depth && !expanded.has(entry.key)) {
        expanded.add(entry.key);
        below = build(entry.record.kind, entry.record.id, level + 1, new Set([...path, entry.key]));
      }
      nodes.push({ entry, ...(below?.nodes.length ? { below } : {}) });
    }
    return { any: parent !== undefined && edgeMode(parent) === "any", nodes };
  };
  return build(kind, id, 1, new Set([refKey(kind, id)]));
}

/** The tree as rows for drawing, with the level of each and, inside an alternatives group, whether it opens it ("either") or follows ("or"). */
export interface UpRow {
  node: UpNode;
  level: number;
  join?: "either" | "or";
}

export function upstreamRows(tree: UpTree, level = 0): UpRow[] {
  return tree.nodes.flatMap((node, index) => [{ node, level, ...(tree.any ? { join: index === 0 ? ("either" as const) : ("or" as const) } : {}) }, ...(node.below ? upstreamRows(node.below, level + 1) : [])]);
}

/** A target this card unblocks, with what ELSE the target waits on. */
export interface AlsoWaits {
  target: ChainNode;
  tree: UpTree;
}

/**
 * "Release B also waits on …": for every open record this card unblocks, the target's other open blockers
 * (the card itself and the chain leading to the target are left out; finished ones are dropped). A
 * target whose blockers are alternatives needs only one of them, so it is not listed.
 */
export function alsoWaitsOn(graph: DepGraph, kind: string, id: string, chain: readonly ChainNode[]): AlsoWaits[] {
  const out: AlsoWaits[] = [];
  const prune = (tree: UpTree): UpTree => ({ any: tree.any, nodes: tree.nodes.filter((node) => node.entry.state !== "done").map((node) => (node.below ? { ...node, below: prune(node.below) } : node)) });
  const walk = (nodes: readonly ChainNode[], path: string[]) => {
    for (const node of nodes) {
      if (node.state !== "open") continue;
      const target = graph.record(node.key);
      if (target && edgeMode(target) === "all") {
        const tree = prune(upstreamTree(graph, node.kind, node.id, new Set([refKey(kind, id), ...path])));
        if (tree.nodes.length) out.push({ target: node, tree });
      }
      walk(node.children, [...path, node.key]);
    }
  };
  walk(chain, []);
  return out;
}

/** Has the record every blocker it needs? any: one done is enough. all: every on-board and external-free list is done. */
export function blockersCleared(record: BoardRecord, entries: readonly ResolvedRef[]): boolean {
  if (edgeMode(record) === "any") return entries.some((entry) => entry.state === "done");
  const onBoard = entries.filter((entry) => entry.state !== "external");
  return onBoard.length > 0 && onBoard.every((entry) => entry.state === "done");
}

/** Will the record never be unblocked? all: some blocker is closed without being done. any: every blocker is. */
export function blockersNeverComing(record: BoardRecord, entries: readonly ResolvedRef[]): ResolvedRef[] {
  const dead = entries.filter((entry) => entry.state === "closed-not-done");
  if (edgeMode(record) === "any") return dead.length === entries.length && entries.length > 0 ? dead : [];
  return dead;
}
