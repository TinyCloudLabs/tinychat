// How an officer's patch becomes a stored record: merged over what is there, timestamps filled in,
// issue links added, checked against the schema and the secret guard. Pure, so the CLI and the tests
// share it; the CLI only adds the reads and writes.
import { isSteer } from "./board";
import { expiryStart } from "./expiry";
import { findRecordSecrets, withIssueLinks } from "./guard";
import { APPEND_ONLY, type Ask, CLOSED_STATUSES, DEFAULT_CLOSE_STATUS, type BoardRecord, type Kind, isClosed, legacyUrgency, STEER_HOURLY_MAX, STEER_OPEN_MAX, validateRecord } from "./schema";

export type Patch = Record<string, unknown>;

export type Outcome =
  | { ok: true; record: BoardRecord; changed: boolean; created: boolean }
  | { ok: false; errors: string[] };

/** Fields the store owns; a patch cannot set them. closedAt is stamped only when an open record becomes closed (below). */
const MANAGED = ["kind", "createdAt", "updatedAt", "closedAt"] as const;
/** On asks and tasks, roci-board owns these too: --expires, --resubmit-of, urgency rises and the watcher set them. */
const CARD_MANAGED = ["resubmitOf", "resubmitCount", "expiresAt", "expiredAt", "expiryBaseAt"] as const;
/** On approvals, roci-board owns the time the urgency last rose. */
const APPROVAL_MANAGED = ["urgencyRaisedAt"] as const;
/** Keys that would change an object's prototype or constructor; no patch may carry them, at any depth. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function forbiddenKeyPath(value: unknown, path: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const hit = forbiddenKeyPath(item, `${path}.${index}`);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return path ? `${path}.${key}` : key;
    const hit = forbiddenKeyPath(item, path ? `${path}.${key}` : key);
    if (hit) return hit;
  }
  return null;
}

/** An openkey read-grant card: what `secret request` posts and `secret redeem` acts on. */
export const READ_GRANT_FIELDS = ["permissions", "names", "scope", "scopeGrant", "profile", "url", "copiedNames", "keepNames", "wholeScopeApprovedBy", "grantMode", "nameWhy", "warning", "partOf"] as const;
const isReadGrant = (record: Patch | null): boolean => record !== null && record.approvalType === "openkey" && Array.isArray(record.names) && record.names.length > 0;

/** Fields that may still change on a ship or order once it is posted. */
const LOG_MUTABLE = new Set(["status", "closedAt", "updatedAt", "links"]);

function defaultsFor(kind: Kind, patch: Patch, now: string): Patch {
  switch (kind) {
    case "ask":
      return { askedAt: now };
    case "approval":
      return { issuedAt: now };
    case "incident":
      return { startedAt: now };
    case "ship":
      return { at: now, title: patch.component && patch.version ? `${patch.component} ${patch.version}` : undefined };
    case "order": {
      const verbatim = typeof patch.verbatim === "string" ? patch.verbatim.trim() : "";
      return { at: now, title: verbatim ? (verbatim.length > 90 ? `${verbatim.slice(0, 88).trimEnd()}…` : verbatim) : undefined };
    }
    case "hold":
      return {};
    case "claim":
      return { title: typeof patch.quote === "string" ? patch.quote.trim().slice(0, 140).trimEnd() : undefined };
    default:
      return {};
  }
}

function stripUndefined(input: Patch): Patch {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/** What Sam reads and agrees to on a go card, including who acts and until when; changing any of it re-issues the card. */
const GO_CONTENT = ["approvalType", "approvalKind", "title", "blocks", "links", "body", "context", "from", "expiresAt"] as const;
/** What a resubmit under a new id copies from the card it replaces, unless the patch gives it. */
const BRIEF_FIELDS = ["title", "body", "owner", "urgency", "importance", "links", "repo", "context", "options", "recommend", "steps", "chatLink", "unblockedBy"] as const;

/**
 * The base a resubmit starts from. Under a new id: the old card's brief, linked by resubmitOf; the old
 * card must be closed (an open one is resubmitted in place). Under the same id: the card reopened
 * with fresh clocks (a dated expiresAt is dropped; "never" stays) and resubmitCount raised.
 */
function resubmitBase(kind: Kind, id: string, prior: Patch | null, old: BoardRecord, patch: Patch, now: string, from: string): { ok: true; base: Patch } | { ok: false; errors: string[] } {
  if (old.kind !== kind || (old.kind !== "ask" && old.kind !== "task")) return { ok: false, errors: [`--resubmit-of ${old.id}: only an ask or task resubmits, as the same kind (got a ${old.kind}, upserting a ${kind})`] };
  if (old.id !== id) {
    if (old.from !== from) return { ok: false, errors: [`--resubmit-of ${old.id}: posted by ${old.from}; only its poster resubmits it`] };
    if (prior) return { ok: false, errors: [`${kind}/${id} already exists; resubmit under a new id, or in place with --id ${old.id}`] };
    if (!isClosed(old)) return { ok: false, errors: [`${kind}/${old.id} is still open; resubmit it in place (--id ${old.id} --resubmit-of ${old.id}) or close it first`] };
    const copied = Object.fromEntries(BRIEF_FIELDS.flatMap((field) => (field in old ? [[field, (old as Patch)[field]]] : [])));
    return { ok: true, base: { ...stripUndefined(defaultsFor(kind, patch, now)), ...copied, createdAt: now, from, resubmitOf: old.id } };
  }
  const base: Patch = { ...prior, createdAt: now, status: kind === "ask" ? "open" : "todo", resubmitCount: (old.resubmitCount ?? 0) + 1 };
  if (kind === "ask") {
    base.askedAt = now;
    delete base.lastAskedAt;
  }
  if (base.expiresAt !== "never") delete base.expiresAt;
  return { ok: true, base };
}

/**
 * Merges `patch` over `existing` (top-level keys replace; `null` removes an optional field) and
 * validates the result. `from` defaults to the posting officer. `resubmitOf` is the card a resubmit
 * replaces (the existing card itself for a resubmit in place); `expiresAt` is a card's --expires
 * (null: back to the urgency default).
 */
export function applyUpsert(kind: Kind, id: string, existing: unknown, patch: Patch, opts: { now: string; from: string; resubmitOf?: BoardRecord; expiresAt?: string | null; trusted?: boolean; edges?: boolean }): Outcome {
  const polluting = forbiddenKeyPath(patch, "");
  if (polluting) return { ok: false, errors: [`${polluting}: the keys __proto__, constructor and prototype are refused at any depth`] };
  const card = kind === "ask" || kind === "task";
  const managed = [...MANAGED, ...(card ? CARD_MANAGED : []), ...(kind === "approval" ? APPROVAL_MANAGED : [])].filter((field) => field in patch && field !== "kind");
  if (managed.length) return { ok: false, errors: managed.map((field) => `${field}: set by roci-board, not by the patch`) };
  // An edge is written only by a path that has checked it (refs exist, none dropped, no loop, the card's own officer): the flags, hold add|update and dep add. upsert --json, --set and batch never carry one, on a hold either. Removing edges (null) is always allowed: the rollback runbook needs it.
  const carriesEdge = Array.isArray(patch.unblockedBy) ? patch.unblockedBy.length > 0 : patch.unblockedBy != null;
  if ((kind === "ask" || kind === "task" || kind === "approval" || kind === "hold") && carriesEdge && !opts.edges) {
    return { ok: false, errors: ["unblockedBy: set it with --unblocked-by / --add-unblocked-by (upsert ask|task, approval add, secret request, hold add|update) or roci-board dep add, not with --set, --json or batch"] };
  }
  if ("kind" in patch && patch.kind !== kind) return { ok: false, errors: [`kind: the patch says "${String(patch.kind)}" but you are upserting a ${kind}`] };
  if ("id" in patch && patch.id !== id) return { ok: false, errors: [`id: the patch says "${String(patch.id)}" but --id is "${id}"`] };
  if (typeof patch.urgency === "string" && patch.urgency in legacyUrgency) {
    return { ok: false, errors: ["urgency: use 0–5: now≈5, today≈3, later≈1"] };
  }

  const secrets = findRecordSecrets(kind, patch);
  if (secrets.length) {
    return {
      ok: false,
      errors: secrets.map((hit) => `${hit.path}: looks like ${hit.reason}; refusing to post it. Link the chat or card instead and keep secrets in TinyCloud Secrets.`),
    };
  }

  const prior = existing && typeof existing === "object" ? (existing as Patch) : null;
  let base: Patch = prior ?? { ...stripUndefined(defaultsFor(kind, patch, opts.now)), createdAt: opts.now, from: opts.from };
  if (opts.resubmitOf) {
    const resubmit = resubmitBase(kind, id, prior, opts.resubmitOf, patch, opts.now, opts.from);
    if (!resubmit.ok) return resubmit;
    base = resubmit.base;
  }

  // Top-level fields replace; object fields (context) merge one level deep. null removes.
  const isPlain = (value: unknown): value is Patch => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const merged: Patch = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    // forAsk is replaced whole: an attach without skipOn must not keep the old card's skipOn.
    else if (isPlain(value) && isPlain(merged[key]) && key !== "forAsk") {
      const inner: Patch = { ...merged[key] };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue === null) delete inner[innerKey];
        else inner[innerKey] = innerValue;
      }
      merged[key] = inner;
    } else merged[key] = value;
  }
  // Sam's cleared blockers are recorded only by the watcher, from his own state record; no officer command, --set, --json or batch item writes them.
  if (kind === "hold" && !opts.trusted && patch.clearedRefs != null) {
    return { ok: false, errors: ["clearedRefs: written by the watcher from Sam's \"Cleared\" button, never by --set, --json or a batch item"] };
  }
  // Only the writer commands that own a part set forAsk (secret request --ask, upsert ask --secret, approval attach); upsert and batch never do.
  if (kind === "approval" && !opts.trusted && "forAsk" in patch) {
    return { ok: false, errors: ["forAsk: set by `secret request --ask` / `approval attach` (or `upsert ask --secret`), never by --set, --json or a batch item"] };
  }
  if (kind === "approval" && !opts.trusted && (isReadGrant(prior) || isReadGrant(merged))) {
    const touched = READ_GRANT_FIELDS.filter((field) => field in patch);
    if (touched.length || isReadGrant(prior) !== isReadGrant(merged)) {
      return { ok: false, errors: [`${touched.length ? touched.join(", ") : "approvalType"}: an openkey read-grant card is changed only by \`roci-board secret request\`; its permissions, names, scope, profile and url cannot be patched`] };
    }
  }
  if (kind === "ask" && typeof merged.urgency === "string" && merged.urgency in legacyUrgency) {
    merged.urgency = legacyUrgency[merged.urgency as keyof typeof legacyUrgency];
  }
  if (card) {
    const urgencyOf = (record: Patch): number => typeof record.urgency === "number" ? record.urgency : legacyUrgency[record.urgency as keyof typeof legacyUrgency] ?? 2;
    if (prior && urgencyOf(merged) > urgencyOf(prior)) merged.expiryBaseAt = opts.now;
    // A re-ask moves a dated expiresAt forward by the lifetime it had.
    if (prior && typeof prior.expiresAt === "string" && prior.expiresAt !== "never" && typeof merged.lastAskedAt === "string" && merged.lastAskedAt !== prior.lastAskedAt) {
      const start = (record: Patch) => expiryStart(record as { createdAt: string; lastAskedAt?: string; expiryBaseAt?: string });
      merged.expiresAt = new Date(Date.parse(prior.expiresAt) - start(prior) + start(merged)).toISOString();
    }
    if (opts.expiresAt === null) delete merged.expiresAt;
    else if (opts.expiresAt !== undefined) merged.expiresAt = opts.expiresAt;
  }
  if (kind === "approval" && prior) {
    const urgencyOf = (record: Patch): number => typeof record.urgency === "number" ? record.urgency : legacyUrgency[record.urgency as keyof typeof legacyUrgency] ?? 2;
    if (urgencyOf(merged) > urgencyOf(prior)) merged.urgencyRaisedAt = opts.now;
  }
  merged.kind = kind;
  merged.id = id;
  merged.updatedAt = opts.now;
  const context = isPlain(merged.context) ? merged.context : {};
  const text = [merged.title, merged.body, merged.verbatim, merged.next, merged.impact, merged.permissions, merged.quote, merged.trueToday, merged.what, merged.cause, merged.exit, context.background, context.whyNow, context.ifNoAnswer, ...(Array.isArray(context.known) ? context.known : [])].filter(
    (part): part is string => typeof part === "string",
  );
  merged.links = withIssueLinks(Array.isArray(merged.links) ? (merged.links as Array<{ label: string; url: string }>) : [], text);
  if (typeof merged.status === "string" && CLOSED_STATUSES[kind].includes(merged.status) && !merged.closedAt && !(prior && CLOSED_STATUSES[kind].includes(String(prior.status)))) merged.closedAt = opts.now;
  if (typeof merged.status === "string" && !CLOSED_STATUSES[kind].includes(merged.status)) delete merged.closedAt;
  if ((kind === "ask" || kind === "task") && merged.status === "expired") merged.expiredAt ??= opts.now;
  else if (kind === "ask" || kind === "task") delete merged.expiredAt;
  if (kind === "hold") {
    // The title follows what is held; a lift stamps liftedAt, and reactivating clears the lift.
    if (typeof merged.what === "string") merged.title = merged.what.trim().length > 140 ? `${merged.what.trim().slice(0, 138).trimEnd()}…` : merged.what.trim();
    if (merged.status === "lifted") merged.liftedAt ??= opts.now;
    else {
      delete merged.liftedAt;
      delete merged.liftReason;
      delete merged.liftedBy;
    }
  }
  if (kind === "incident" && merged.status === "resolved" && !merged.resolvedAt) merged.resolvedAt = opts.now;
  // A go is tied to what Sam saw: a patch that changes what the card says (turning it into another
  // approval type included) re-issues it, so an answer given before no longer counts. Patches that
  // leave the content alone (the watcher's answered mark) do not.
  if (kind === "approval" && prior && (merged.approvalType === "go" || prior.approvalType === "go") && GO_CONTENT.some((field) => field in patch && stable(prior[field]) !== stable(merged[field]))) {
    merged.issuedAt = opts.now;
    if (merged.status === "answered") merged.status = "open";
  }

  if (prior && APPEND_ONLY.includes(kind)) {
    const changedFields = Object.keys({ ...prior, ...merged }).filter((key) => !LOG_MUTABLE.has(key) && stable(prior[key]) !== stable(merged[key]));
    if (changedFields.length) {
      return { ok: false, errors: [`${kind} records are append-only; only status can change after posting (tried to change ${changedFields.join(", ")}). Post a new ${kind} instead.`] };
    }
  }

  const checked = validateRecord(kind, merged);
  if (!checked.ok) return checked;
  // An upsert that changes nothing keeps the stored record, updatedAt included.
  // A no-op against a legacy ask does not rewrite KV just to convert its old urgency word.
  const comparablePrior = prior && kind === "ask" && typeof prior.urgency === "string" && prior.urgency in legacyUrgency
    ? { ...prior, urgency: legacyUrgency[prior.urgency as keyof typeof legacyUrgency] } : prior;
  const unchanged = comparablePrior !== null && stable({ ...comparablePrior, updatedAt: null }) === stable({ ...checked.value, updatedAt: null });
  return { ok: true, record: unchanged ? (prior as BoardRecord) : checked.value, changed: !unchanged, created: !prior };
}

/** The patch `roci-board close` applies. */
export function closePatch(kind: Kind, status: string | undefined): { ok: true; patch: Patch } | { ok: false; error: string } {
  if (kind === "hold") return { ok: false, error: 'a hold is lifted with its reason: roci-board hold lift <id> --reason "…"' };
  const target = status ?? DEFAULT_CLOSE_STATUS[kind];
  if (!CLOSED_STATUSES[kind].includes(target)) {
    return { ok: false, error: `a ${kind} closes with one of: ${CLOSED_STATUSES[kind].join(", ")} (got "${target}")` };
  }
  return { ok: true, patch: { status: target } };
}

const HOUR_MS = 3_600_000;

/**
 * The Steer rate limit, checked before writing `incoming` over the asks on the board: per poster
 * (`from`), at most STEER_OPEN_MAX open proceeding asks, and STEER_HOURLY_MAX posted (created,
 * re-asked, or switched to proceeding) in any rolling hour. Only new posts are counted against it:
 * edits to an open Steer question, `steer done` and closes always go through. Returns one error per
 * refused ask, prefixed with its id.
 */
export function steerQuota(existing: readonly Ask[], incoming: readonly Ask[], now: string): string[] {
  const posted = (ask: Ask) => ask.lastAskedAt ?? ask.askedAt;
  const board = new Map(existing.map((ask) => [ask.id, ask]));
  const isNewPost = (ask: Ask) => {
    const prior = board.get(ask.id);
    return isSteer(ask) && ask.status === "open" && (!prior || !isSteer(prior) || prior.status !== "open" || posted(prior) !== posted(ask));
  };
  const fresh = incoming.filter(isNewPost);
  // Edits and closes in the same write land first, so a batch that closes one Steer question can post another.
  for (const ask of incoming) if (!fresh.includes(ask)) board.set(ask.id, ask);

  // Each stored Steer record is its latest post; a re-ask adds a post rather than replacing one.
  const posts = existing.filter(isSteer);
  const since = Date.parse(now) - HOUR_MS;
  const errors: string[] = [];
  for (const ask of fresh) {
    const open = [...board.values()].filter((other) => other.id !== ask.id && other.from === ask.from && isSteer(other) && other.status === "open");
    const lastHour = posts.filter((post) => post.from === ask.from && Date.parse(posted(post)) > since).sort((a, b) => posted(a).localeCompare(posted(b)));
    if (open.length >= STEER_OPEN_MAX) {
      errors.push(
        `${ask.id}: steer limit: ${ask.from} already has ${open.length} open Steer questions (${open.map((other) => other.id).join(", ")}); at most ${STEER_OPEN_MAX}. Close one first (roci-board close ask <id>), or fold this choice into one of them.`,
      );
    } else if (lastHour.length >= STEER_HOURLY_MAX) {
      const nextFree = new Date(Date.parse(posted(lastHour[lastHour.length - STEER_HOURLY_MAX]!)) + HOUR_MS).toISOString();
      errors.push(
        `${ask.id}: steer limit: ${ask.from} posted ${lastHour.length} Steer questions in the past hour; at most ${STEER_HOURLY_MAX}. The next one fits after ${nextFree}; until then, group choices into fewer questions or go ahead without asking.`,
      );
    } else {
      board.set(ask.id, ask);
      posts.push(ask);
    }
  }
  return errors;
}
