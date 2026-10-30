// The one record format for the Rocinante sitrep. The roci-board CLI (officers write) and the web
// app (Sam reads, answers, checks off) both import this module, so the two always agree.
//
// KV layout, all in Sam's `applications` space, under APP_ID/:
//   board/<kind>/<id>.json             written only by officers, through roci-board
//   board/chat/<stamp>.json            officers' messages in Sam's XO thread (roci-board chat)
//   board/watch/chat.json              the watcher's delivery receipt for Sam's chat messages
//   sam/answers/<askId>/<stamp>.json   written only by Sam's browser (append-only; also approval codes)
//   sam/state/<kind>/<id>.json         written only by Sam's browser (seen, dismissed, step checks, snoozes, priority)
//   sam/chat/<stamp>.json              Sam's messages to the XO (append-only)
//   sam/claims/<claimId>/<stamp>.json  Sam's keep/remove/ignore decisions (append-only)
//   board/interview/<step>.json        the watcher's view of one of Monica's interviews with Sam
//   sam/interview/<agentId>/<stamp>-<nonce>.json  Sam's replies to an interviewer (append-only)
//   sam/prefs/group-priority.json      Sam's group priority decisions, written only by Sam's browser
import { z } from "zod";
import { approvalUrlKind, findSecrets } from "./guard";
import { resolveRepo } from "./links";

export const APP_ID = "xyz.tinycloud.rocinante";
export const SPACE = "applications";
export const ROOT_PREFIX = `${APP_ID}/`;
export const BOARD_PREFIX = `${ROOT_PREFIX}board/`;
export const SAM_PREFIX = `${ROOT_PREFIX}sam/`;
export const ANSWERS_PREFIX = `${SAM_PREFIX}answers/`;
export const CLAIMS_PREFIX = `${SAM_PREFIX}claims/`;
export const STATE_PREFIX = `${SAM_PREFIX}state/`;
export const SAM_CHAT_PREFIX = `${SAM_PREFIX}chat/`;
export const BOARD_CHAT_PREFIX = `${BOARD_PREFIX}chat/`;
export const CHAT_RECEIPT_KEY = `${BOARD_PREFIX}watch/chat.json`;
export const INTERVIEW_PREFIX = `${BOARD_PREFIX}interview/`;
export const SAM_INTERVIEW_PREFIX = `${SAM_PREFIX}interview/`;
export const PREFS_PREFIX = `${SAM_PREFIX}prefs/`;
export const GROUP_PRIORITY_KEY = `${PREFS_PREFIX}group-priority.json`;

export const KINDS = ["ask", "task", "approval", "incident", "work", "ship", "order", "claim", "hold", "progress"] as const;
export type Kind = (typeof KINDS)[number];
export const isKind = (value: unknown): value is Kind => typeof value === "string" && (KINDS as readonly string[]).includes(value);

export const BODY_MAX = 600;
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,79}$/;
export const CLAIM_ID_RE = /^[A-Z]-[0-9]{2,}$/;
export const validRecordId = (kind: Kind, id: string): boolean => kind === "claim" ? id.length <= 80 && CLAIM_ID_RE.test(id) : ID_RE.test(id);
const SHORT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

const Id = z.string().regex(ID_RE, "use lowercase a-z, 0-9, '.', '_' or '-' (at most 80), e.g. tc-950-provider");
const ClaimId = z.string().max(80).regex(CLAIM_ID_RE, "use an uppercase letter, hyphen and at least two digits, e.g. L-042");
const ShortId = z.string().regex(SHORT_ID_RE, "use lowercase a-z, 0-9, '_' or '-' (at most 24), e.g. a, rds, qa-user");
const Iso = z.string().datetime({ offset: true, message: "use an ISO 8601 timestamp, e.g. 2026-10-13T15:42:00Z" });
/** Names reach agents and command lines (paseo --label …=<Name>); a NUL there breaks every relay. */
const Name = z.string().trim().min(1).max(40).refine((name) => !/[\p{Cc}\p{Cf}]/u.test(name), "names cannot contain control or invisible characters");
/** Card groups (docs/SPEC-card-groups.md): a plain-text label that files open asks, tasks and approvals under one header. */
const GroupName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((group) => !/[\p{Cc}\p{Cf}]/u.test(group), "group cannot contain control or invisible characters")
  .refine((group) => !/https?:\/\/|www\.|[`*\[\]<>]/i.test(group), "group is plain text: no links, markdown or HTML, e.g. \"Release blockers\"");
const groupField = GroupName.optional();

/** Priority (docs/SPEC-priority.md): an item Sam named, or one an officer says it blocks. Plain text, at most 140 characters. */
export const PRIORITY_REASON_MAX = 140;
/** An officer's reason cites Sam's words in quotes, or says what Sam priority it blocks ("blocks …"). */
export const citesPriority = (reason: string): boolean => /"[^"\n]+"|“[^”\n]+”|\bblocks /i.test(reason);
export const PRIORITY_REFUSAL = "Priority is for items Sam named or that block one: cite his words or say what Sam priority it blocks";
const PriorityReason = z
  .string()
  .trim()
  .min(1)
  .max(PRIORITY_REASON_MAX)
  .refine((reason) => !/[\p{Cc}\p{Cf}]/u.test(reason), "reason cannot contain control or invisible characters")
  .refine((reason) => !/https?:\/\/|www\.|[`*\[\]<>]/i.test(reason), "reason is plain text: no links, markdown or HTML");
export const PrioritySchema = z
  .object({ by: z.enum(["sam", "officer"]), reason: PriorityReason, at: Iso })
  .strict()
  .superRefine((priority, ctx) => {
    if (priority.by === "officer" && !citesPriority(priority.reason)) ctx.addIssue({ code: "custom", path: ["reason"], message: PRIORITY_REFUSAL });
  });
export type Priority = z.infer<typeof PrioritySchema>;
const priorityField = { priority: PrioritySchema.optional() };

/** A record or external item a card or hold waits on: kind:id for ask, task, approval or hold; a Linear key (TC-1162); or a GitHub ref (owner/repo#12, short-repo#12, or a github.com issue/PR URL). */
export const DEP_REF_KINDS = ["ask", "task", "approval", "hold"] as const;
export const DEP_REF_RE = /^(?:(?:ask|task|approval|hold):[a-z0-9][a-z0-9._-]{0,79}|[A-Z][A-Z0-9]{1,9}-[1-9][0-9]*|(?:[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*#[1-9][0-9]*|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/[1-9][0-9]*)$/;
const DepRef = z.string().trim().regex(DEP_REF_RE, "use ask:<id>, task:<id>, approval:<id>, hold:<id>, a Linear key (TC-1162) or a GitHub ref (owner/repo#12)");

/**
 * What an ask, task or approval waits on (stored on the dependent side only, like a hold's). Optional with
 * min(1) and NO default: the CLI writes the parsed value, so a default of [] would put the key on every
 * card it writes and an older strict reader would reject them all. Absent means no edges; clear with --unset.
 */
const depFields = { unblockedBy: z.array(DepRef).min(1).max(12).optional() };

function checkDeps(card: { kind: string; id: string; unblockedBy?: string[] | undefined }, ctx: z.RefinementCtx): void {
  const refs = card.unblockedBy ?? [];
  if (refs.includes(`${card.kind}:${card.id}`)) ctx.addIssue({ code: "custom", path: ["unblockedBy"], message: `a ${card.kind} cannot be unblocked by itself` });
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", path: ["unblockedBy"], message: "unblockedBy names the same reference twice" });
}

const HttpUrl = z
  .string()
  .url()
  .max(500)
  .refine((url) => /^https?:\/\//i.test(url), "links must be http(s) URLs");
const EvidenceRef = z.string().trim().min(1).max(500).refine(
  (ref) => HttpUrl.safeParse(ref).success || /^(?:\.?[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*:[1-9][0-9]*$/.test(ref),
  "use an HTTP(S) URL or a relative repository file path with :line",
);

export const LinkSchema = z.object({ label: z.string().trim().min(1).max(80), url: HttpUrl }).strict();

const PriorityScore = z.number().int().min(0).max(5);
const LEGACY_URGENCIES = ["now", "today", "later"] as const;
export const legacyUrgency = { now: 5, today: 3, later: 1 } as const;
export type Link = z.infer<typeof LinkSchema>;

const common = {
  id: Id,
  title: z.string().trim().min(1).max(140),
  /** Markdown, at most 600 characters. Say what changed and what you need, not the whole story. */
  body: z.string().max(BODY_MAX).default(""),
  /** Who owns the work. */
  owner: Name.optional(),
  /** Which officer posted it. */
  from: Name,
  urgency: PriorityScore.optional(),
  importance: PriorityScore.optional(),
  links: z.array(LinkSchema).max(16).default([]),
  /** The GitHub repo a bare #123 in this item refers to: "owner/repo" or a short name like "js-sdk". */
  repo: z.string().trim().regex(/^(?:[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*$/, 'use "owner/repo" or a short repo name like js-sdk').max(100).optional(),
  createdAt: Iso,
  updatedAt: Iso,
  /** What waiting on Sam holds up, in a few words ("node logs", "security release"). Naming prod or security puts it first in his Waiting list. */
  blocks: z.string().trim().min(1).max(80).optional(),
  closedAt: Iso.optional(),
};

const BRIEF_HINT = "Brief Sam from zero: assume he has forgotten the topic.";

/**
 * The brief on every item that needs Sam. He tracks a lot; each card has to make sense on its own,
 * with no acronym left unexplained and every number linked or sourced.
 */
export const ContextSchema = z
  .object({
    /** What this is and how we got here, in plain words. */
    background: z
      .string({ required_error: `context.background is missing: what this is and how we got here, in plain words (60-400 chars). ${BRIEF_HINT}` })
      .trim()
      .min(60, `context.background is too short: say what this is and how we got here, in plain words (at least 60 chars). ${BRIEF_HINT}`)
      .max(400, "context.background: keep it under 400 chars; put the rest in known or body"),
    /** Why it needs Sam now, and what it is blocking. Required except on a proceeding (Steer) ask. */
    whyNow: z.string().trim().min(15, "context.whyNow is too short: why this needs Sam now and what it is blocking").max(300).optional(),
    /** What happens if he doesn't answer: the default, or when it goes stale. Required on asks. */
    ifNoAnswer: z.string().trim().min(10, "context.ifNoAnswer is too short: what happens by default, or by when it goes stale").max(300).optional(),
    /** Facts already established: numbers (each linked or sourced), earlier decisions, Sam's own words. */
    known: z.array(z.string().trim().min(1).max(240)).max(8).default([]),
    /** Earlier ask ids on the same topic; the card shows Sam's answers to them. */
    related: z.array(Id).max(8).default([]),
  })
  .strict();
export type Context = z.infer<typeof ContextSchema>;

const contextField = (hint: string) =>
  z.custom<unknown>((value) => value !== undefined && value !== null, { message: `context is missing: give ${hint}. ${BRIEF_HINT}` }).pipe(ContextSchema);

/**
 * Card expiry on asks and tasks (shared/expiry.ts). Without expiresAt a card expires by its urgency;
 * "never" is for standing items. The watcher sets status "expired" with expiredAt; a resubmit links
 * the card it replaces (resubmitOf), or counts resubmits under the same id (resubmitCount). All are
 * managed by roci-board (shared/upsert.ts); expiryBaseAt is when the urgency last rose.
 */
const expiryFields = {
  expiresAt: z.union([Iso, z.literal("never")]).optional(),
  expiredAt: Iso.optional(),
  resubmitOf: Id.optional(),
  resubmitCount: z.number().int().min(1).optional(),
  expiryBaseAt: Iso.optional(),
};

function checkExpired(card: { status: string; expiredAt?: string }, ctx: z.RefinementCtx): void {
  if ((card.status === "expired") !== (card.expiredAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["expiredAt"], message: "expiredAt goes with status expired, and only with it" });
  }
}

export const AskOptionSchema = z
  .object({
    id: ShortId,
    label: z.string().trim().min(1).max(80),
    detail: z.string().max(280).optional(),
    cost: z.string().max(80).optional(),
  })
  .strict();
export type AskOption = z.infer<typeof AskOptionSchema>;

/**
 * blocking: the officer waits for Sam. proceeding (a Steer question): the officer goes ahead with
 * `default` at `decideBy` unless Sam says otherwise, and sets `proceededAt` at its point of no return.
 */
export const ASK_MODES = ["blocking", "proceeding"] as const;
export type AskMode = (typeof ASK_MODES)[number];
/** Steer rate limit per --from: open proceeding asks at once, and posted in any rolling hour. */
export const STEER_OPEN_MAX = 3;
export const STEER_HOURLY_MAX = 6;

const WHY_NOW_MISSING = "context.whyNow is missing: why this needs Sam now and what it is blocking";
const STEER_ONLY = ["default", "decideBy", "proceededAt"] as const;

export const AskSchema = z
  .object({
    ...common,
    ...priorityField,
    ...expiryFields,
    ...depFields,
    kind: z.literal("ask"),
    urgency: z.union([PriorityScore, z.enum(LEGACY_URGENCIES)]).optional(),
    deadline: Iso.optional(),
    options: z.array(AskOptionSchema).max(8).default([]),
    /** The option id the officer recommends; "Accept all recommendations" picks it. */
    recommend: ShortId.optional(),
    askedAt: Iso,
    /** Set when the officer asks again; an answer older than this no longer counts. */
    lastAskedAt: Iso.optional(),
    status: z.enum(["open", "answered", "dropped", "stale", "superseded", "expired"]).default("open"),
    supersededBy: Id.optional(),
    /** Absent means blocking. */
    mode: z.enum(ASK_MODES).optional(),
    /** Proceeding asks: the option id the officer goes ahead with unless Sam picks another. */
    default: ShortId.optional(),
    /** Proceeding asks: when the window closes and the officer goes ahead with the default. */
    decideBy: Iso.optional(),
    /** Proceeding asks: when the officer passed its point of no return (roci-board steer done). */
    proceededAt: Iso.optional(),
    /** Card group: asks in the same group show under one header (Waiting and Asks). Absent = ungrouped. */
    group: groupField,
    context: contextField("context.background, context.whyNow and context.ifNoAnswer (a proceeding Steer ask needs only context.background)"),
  })
  .strict()
  .superRefine((ask, ctx) => {
    checkExpired(ask, ctx);
    checkDeps(ask, ctx);
    if (ask.mode === "proceeding") {
      if (!ask.default) ctx.addIssue({ code: "custom", path: ["default"], message: "default is missing: a proceeding ask names the option it goes ahead with (--default <optionId>)" });
      if (!ask.decideBy) ctx.addIssue({ code: "custom", path: ["decideBy"], message: "decideBy is missing: when the window closes and you go ahead (--decide-by 30m|2h|tonight|ISO)" });
    } else {
      if (!ask.context.whyNow) ctx.addIssue({ code: "custom", path: ["context", "whyNow"], message: WHY_NOW_MISSING });
      if (!ask.context.ifNoAnswer) {
        ctx.addIssue({ code: "custom", path: ["context", "ifNoAnswer"], message: "context.ifNoAnswer is missing: what happens if Sam doesn't answer (the default), or by when it goes stale" });
      }
      for (const field of STEER_ONLY) {
        if (ask[field] !== undefined) ctx.addIssue({ code: "custom", path: [field], message: `${field}: only a proceeding (Steer) ask has one; pass --mode proceeding, or --unset ${field}` });
      }
    }
    if (ask.recommend && !ask.options.some((option) => option.id === ask.recommend)) {
      ctx.addIssue({ code: "custom", path: ["recommend"], message: `recommend "${ask.recommend}" is not one of the option ids` });
    }
    if (ask.default && !ask.options.some((option) => option.id === ask.default)) {
      ctx.addIssue({ code: "custom", path: ["default"], message: `default "${ask.default}" is not one of the option ids` });
    }
    const ids = ask.options.map((option) => option.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
  });

export const TaskStepSchema = z.object({ id: ShortId, text: z.string().trim().min(1).max(200) }).strict();
export const TaskSchema = z
  .object({
    ...common,
    ...priorityField,
    ...expiryFields,
    ...depFields,
    kind: z.literal("task"),
    /** Sam ticks steps off in his browser; the ticks live in sam/state, never here. */
    steps: z.array(TaskStepSchema).max(20).default([]),
    deadline: Iso.optional(),
    /** Where Sam does it: the chat or card. Never an approval URL. */
    chatLink: HttpUrl.optional(),
    status: z.enum(["todo", "done", "n/a", "expired"]).default("todo"),
    group: groupField,
    context: contextField("context.background and context.whyNow"),
  })
  .strict()
  .superRefine((task, ctx) => {
    checkExpired(task, ctx);
    checkDeps(task, ctx);
    if (!task.context.whyNow) ctx.addIssue({ code: "custom", path: ["context", "whyNow"], message: WHY_NOW_MISSING });
    const ids = task.steps.map((step) => step.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "step ids must be unique" });
  });

export const APPROVAL_TYPES = ["openkey", "delegation", "claude", "secret", "go"] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
/** What a "go" approval releases: Sam's go on a release, a deploy window, a spend or a publication. */
export const GO_KINDS = ["release", "deploy", "spend", "publish"] as const;
export type GoKind = (typeof GO_KINDS)[number];
/** A TinyCloud Secrets name, as `tc secrets` takes it. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A TinyCloud Secrets scope: secrets live at vault/secrets/scoped/<scope>/NAME. The same rules `tc` enforces (@tinycloud/operations secret-request). */
export const SECRET_SCOPE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SECRET_SCOPE_MAX = 64;
export const SECRET_SCOPE_RESERVED: readonly string[] = ["default", "global", "scoped"];
export const isSecretScope = (scope: string): boolean => scope.length <= SECRET_SCOPE_MAX && SECRET_SCOPE_RE.test(scope) && !SECRET_SCOPE_RESERVED.includes(scope);
/** The only scopes a whole-scope read grant (`--all-in-scope`) may cover: Sam's 20:56Z answer to card sf-scope-grant-shape named software-factory. Adding another needs his word. */
export const WHOLE_SCOPE_ALLOWED: readonly string[] = ["software-factory"];
/** Longest `permissions` text an approval may carry. */
export const PERMISSIONS_MAX = 600;
/** Most secret names one read grant may cover. */
export const GRANT_NAMES_MAX = 10;

/**
 * Something only Sam can approve: an OpenKey sign-in or delegation, or a Claude sign-in from
 * `claude setup-token` (he opens the consent page and pastes the code it shows back into the card),
 * a TinyCloud secret to add
 * (he types the value on the official Secret Manager page; it never passes through the board), or
 * his go on a release, deploy, spend or publication (`approvalType: "go"`, `approvalKind`; no url,
 * the release notes or PR go in `links`). `url` is the one field the secret guard lets carry a
 * consent link, and only an allowlisted one.
 */
export const ApprovalSchema = z
  .object({
    ...common,
    ...priorityField,
    ...depFields,
    kind: z.literal("approval"),
    approvalType: z.enum(APPROVAL_TYPES),
    /** Go approvals: what Sam's go releases. */
    approvalKind: z.enum(GO_KINDS).optional(),
    /** The consent page: openkey.so/delegate|device|oauth/consent, claude.com/cai/oauth/authorize (claude), or secrets.tinycloud.xyz/request for secrets. Absent on go approvals. */
    url: z.string().max(16000).optional(),
    /** When this link was (re)issued; a code pasted before it no longer counts. */
    issuedAt: Iso,
    expiresAt: Iso.optional(),
    /** The time Sam must act by (same format as an ask's); shows in the Next deadline readout. Absent on every older card. */
    deadline: Iso.optional(),
    /** When the urgency last rose (set by roci-board, shared/upsert.ts): a rise brings a snoozed card back early. */
    urgencyRaisedAt: Iso.optional(),
    /** What approving grants, in plain words. */
    permissions: z.string().trim().min(1).max(PERMISSIONS_MAX).optional(),
    /** Secret requests: names to add; read grants: every name the grant covers (including --keep). */
    names: z.array(z.string().regex(SECRET_NAME_RE, "UPPER_SNAKE secret names")).min(1).max(GRANT_NAMES_MAX).optional(),
    /** Read grants: the requested names the officer says it already copied into the scope; the card shows them in full. */
    copiedNames: z.array(z.string().regex(SECRET_NAME_RE, "UPPER_SNAKE secret names")).min(1).max(GRANT_NAMES_MAX).optional(),
    /** Numbered steps Sam follows, shown on the card itself (secret and go/consent cards alike). */
    steps: z.array(z.string().trim().min(1).max(300)).min(1).max(12).optional(),
    /** The tc profile the approval is for, e.g. roci-xo. */
    profile: z.string().trim().regex(/^[A-Za-z0-9][\w.-]{0,63}$/, "a tc profile name, e.g. roci-xo").optional(),
    /** Claude sign-ins: whose seat or account the code is for, so two cards on one officer's list tell apart. */
    target: z.string().trim().min(1, "a claude sign-in names its target: --target \"…\"").max(120).optional(),
    /** The consent page shows a code that Sam pastes into the card. */
    codeExpected: z.boolean().default(false),
    /** Secret approvals: first TinyCloud Secrets name to add (also used by older single-name cards). */
    name: z.string().regex(SECRET_NAME_RE, "an UPPER_SNAKE secret name, e.g. ELEVENLABS_API_KEY").optional(),
    /** Secret requests and read grants: the TinyCloud Secrets scope the names live in; absent = top level. */
    scope: z.string().refine(isSecretScope, "a secrets scope, e.g. software-factory: lowercase letters and digits in hyphen-separated parts, at most 64 characters, not default, global or scoped").optional(),
    /** Scoped read grants: "all" = one grant on every secret under vault/secrets/scoped/<scope>/ (Sam's 20:56Z answer to sf-scope-grant-shape); absent = one grant per name. Needs scope. */
    scopeGrant: z.literal("all").optional(),
    /** Read grants: the --keep names the grant adds beyond the requested ones (a subset of names). Absent on older cards: every name was requested. */
    keepNames: z.array(z.string().regex(SECRET_NAME_RE, "UPPER_SNAKE secret names")).min(1).max(GRANT_NAMES_MAX).optional(),
    /** Whole-scope read grants: the card or message where Sam approved this profile's whole-scope grant. Set only by `secret request --whole-scope-approved`; `secret redeem` checks it, not the text. */
    wholeScopeApprovedBy: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/, "an id of the card or message where Sam approved it").optional(),
    /** Grants: "write" = the profile may put exactly `names` (kv put, no decrypt); absent = the usual read grant. Set only by `secret request --write`. */
    grantMode: z.literal("write").optional(),
    /** Write grants: why each name is needed, shown on the card; a write grant covers no name without one. */
    nameWhy: z.array(z.object({ name: z.string().regex(SECRET_NAME_RE, "UPPER_SNAKE secret names"), why: z.string().trim().min(1).max(300) }).strict()).min(1).max(GRANT_NAMES_MAX).optional(),
    /** Write grants: the red line on the card about what approving can break. */
    warning: z.string().trim().min(1).max(300).optional(),
    /** A step of another approval (the read grant of a secret card); shown inside that card. */
    partOf: Id.optional(),
    /** A part of an ask: Sam sees it inside that ask's card (shared/board.ts askParts). skipOn: option ids that make it unneeded. Set only by a writer that owns this approval; absent on every older card. */
    forAsk: z.object({ id: Id, skipOn: z.array(ShortId).min(1).max(8).optional() }).strict().optional(),
    /** Card group: approvals in the same group show under one header (Waiting). Absent = ungrouped. */
    group: groupField,
    status: z.enum(["open", "answered", "done", "cancelled", "expired"]).default("open"),
    context: contextField("context.background, context.whyNow and context.ifNoAnswer"),
  })
  .strict()
  .superRefine((approval, ctx) => {
    checkDeps(approval, ctx);
    if (!approval.context.whyNow) ctx.addIssue({ code: "custom", path: ["context", "whyNow"], message: WHY_NOW_MISSING });
    if (!approval.context.ifNoAnswer) {
      ctx.addIssue({ code: "custom", path: ["context", "ifNoAnswer"], message: "context.ifNoAnswer is missing: what happens if Sam doesn't approve, or by when the link goes stale" });
    }
    if (approval.approvalType === "go") {
      if (!approval.approvalKind) ctx.addIssue({ code: "custom", path: ["approvalKind"], message: `a go approval says what it releases: --kind ${GO_KINDS.join("|")}` });
      if (approval.url !== undefined) ctx.addIssue({ code: "custom", path: ["url"], message: "a go approval has no consent url; link the release notes or PR with --link label=url" });
      if (approval.codeExpected) ctx.addIssue({ code: "custom", path: ["codeExpected"], message: "a go approval has no code: Sam taps Give the go" });
    } else if (approval.approvalKind) {
      ctx.addIssue({ code: "custom", path: ["approvalKind"], message: "approvalKind (--kind) is only for go approvals" });
    }
    const urlKind = approval.url === undefined ? null : approvalUrlKind(approval.url);
    if (approval.approvalType === "secret") {
      if (urlKind !== "secrets") ctx.addIssue({ code: "custom", path: ["url"], message: "a secret approval links the Secret Manager request page (https://secrets.tinycloud.xyz/request?…) from `tc secrets request`" });
      if (!approval.name) ctx.addIssue({ code: "custom", path: ["name"], message: "a secret approval names the secret" });
      if (approval.names && approval.name !== approval.names[0]) ctx.addIssue({ code: "custom", path: ["names"], message: "the first secret name must match name" });
      if (approval.codeExpected) ctx.addIssue({ code: "custom", path: ["codeExpected"], message: "a secret approval has no code; the read grant is its own openkey approval with partOf" });
    } else if (approval.approvalType === "claude") {
      if (urlKind !== "claude") ctx.addIssue({ code: "custom", path: ["url"], message: "a claude sign-in links the consent page `claude setup-token` prints: https://claude.com/cai/oauth/authorize?…" });
      if (!approval.target) ctx.addIssue({ code: "custom", path: ["target"], message: "a claude sign-in names whose seat or account it is for: --target \"…\"" });
      if (!approval.codeExpected) ctx.addIssue({ code: "custom", path: ["codeExpected"], message: "a claude sign-in takes the code Sam pastes back from the consent page" });
    } else if (approval.approvalType !== "go" && urlKind !== "openkey") {
      ctx.addIssue({ code: "custom", path: ["url"], message: "an openkey or delegation approval links an OpenKey consent page: https://openkey.so/delegate?…, /device?… or /oauth/consent?…" });
    }
    if (approval.partOf === approval.id) ctx.addIssue({ code: "custom", path: ["partOf"], message: "an approval cannot be part of itself" });
    if (approval.forAsk) {
      const secretOrGrant = approval.approvalType === "secret" || (approval.approvalType === "openkey" && Boolean(approval.names?.length));
      if (!secretOrGrant) ctx.addIssue({ code: "custom", path: ["forAsk"], message: "forAsk only goes on a secret card or an openkey grant with names" });
      if (approval.forAsk.id === approval.id) ctx.addIssue({ code: "custom", path: ["forAsk", "id"], message: "a part cannot share its ask's id (one answer namespace)" });
      if (approval.forAsk.skipOn && new Set(approval.forAsk.skipOn).size !== approval.forAsk.skipOn.length) ctx.addIssue({ code: "custom", path: ["forAsk", "skipOn"], message: "skipOn lists each option once" });
    }
    if (approval.copiedNames) {
      if (new Set(approval.copiedNames).size !== approval.copiedNames.length) ctx.addIssue({ code: "custom", path: ["copiedNames"], message: "copiedNames lists each name once" });
      if (approval.copiedNames.some((name) => !approval.names?.includes(name))) ctx.addIssue({ code: "custom", path: ["copiedNames"], message: "copiedNames are names the grant covers (they must also be in names)" });
    }
    if (approval.keepNames?.some((name) => !approval.names?.includes(name))) ctx.addIssue({ code: "custom", path: ["keepNames"], message: "keepNames are names the grant covers (they must also be in names)" });
    if (approval.wholeScopeApprovedBy && !approval.scopeGrant) ctx.addIssue({ code: "custom", path: ["wholeScopeApprovedBy"], message: "wholeScopeApprovedBy only goes with scopeGrant" });
    if (approval.grantMode === "write") {
      if (approval.approvalType !== "openkey") ctx.addIssue({ code: "custom", path: ["grantMode"], message: "grantMode write only goes with an openkey grant" });
      if (approval.scopeGrant || approval.keepNames || approval.copiedNames) ctx.addIssue({ code: "custom", path: ["grantMode"], message: "a write grant covers exact names: no scopeGrant, keepNames or copiedNames" });
      if (approval.partOf) ctx.addIssue({ code: "custom", path: ["partOf"], message: "a write grant covers exact names and is never part of another card: no partOf" });
    }
    if (approval.grantMode === "write") {
      if (!approval.scope) ctx.addIssue({ code: "custom", path: ["scope"], message: "a write grant needs the scope its secrets live in: --scope" });
      if (!approval.names) ctx.addIssue({ code: "custom", path: ["names"], message: "a write grant names the secrets it may put" });
      for (const name of approval.names ?? []) {
        if (!approval.nameWhy?.some((entry) => entry.name === name)) ctx.addIssue({ code: "custom", path: ["nameWhy"], message: `nameWhy needs a reason for ${name}: a write grant says why each name is needed` });
      }
      if (approval.nameWhy?.some((entry) => !approval.names?.includes(entry.name))) ctx.addIssue({ code: "custom", path: ["nameWhy"], message: "nameWhy names are names the grant covers (they must also be in names)" });
      if (approval.nameWhy && new Set(approval.nameWhy.map((entry) => entry.name)).size !== approval.nameWhy.length) ctx.addIssue({ code: "custom", path: ["nameWhy"], message: "nameWhy gives each name one reason" });
    } else if (approval.nameWhy || approval.warning) {
      ctx.addIssue({ code: "custom", path: ["grantMode"], message: "nameWhy and warning only go with a write grant" });
    }
    if (approval.scopeGrant && !(approval.scope && WHOLE_SCOPE_ALLOWED.includes(approval.scope))) ctx.addIssue({ code: "custom", path: ["scopeGrant"], message: `scopeGrant needs a scope Sam approved for whole-scope reads (${WHOLE_SCOPE_ALLOWED.join(", ")}); it never covers the top level` });
  });

export const IncidentSchema = z
  .object({
    ...common,
    kind: z.literal("incident"),
    status: z.enum(["degraded", "mitigated", "resolved"]).default("degraded"),
    severity: z.enum(["sev1", "sev2", "sev3"]).optional(),
    impact: z.string().max(280).default(""),
    startedAt: Iso,
    resolvedAt: Iso.optional(),
  })
  .strict();

export const WorkSchema = z
  .object({
    ...common,
    kind: z.literal("work"),
    status: z.enum(["active", "waiting-sam", "waiting-other", "blocked", "done"]).default("active"),
    next: z.string().max(200).optional(),
    waitsOn: z.string().max(120).optional(),
    askIds: z.array(Id).max(12).default([]),
    /** A standing loop rather than a one-off job. */
    standing: z.boolean().default(false),
  })
  .strict();

export const ShipSchema = z
  .object({
    ...common,
    kind: z.literal("ship"),
    at: Iso,
    component: z.string().trim().min(1).max(40),
    version: z.string().trim().min(1).max(40),
    prevVersion: z.string().trim().max(40).optional(),
    status: z.enum(["live", "rolled-back"]).default("live"),
  })
  .strict();

export const OrderSchema = z
  .object({
    ...common,
    kind: z.literal("order"),
    at: Iso,
    /** "chat" for Sam's own words, "relay:Naomi" when passed on. */
    source: z.string().trim().min(1).max(60).default("chat"),
    /** Sam's words, unedited. */
    verbatim: z.string().trim().min(1).max(1200),
    appliesTo: z.string().max(120).optional(),
    status: z.enum(["active", "retired"]).default("active"),
  })
  .strict();

/** One site claim audited against current evidence. Sam's decisions live separately under sam/claims. */
export const ClaimSchema = z
  .object({
    ...common,
    id: ClaimId,
    kind: z.literal("claim"),
    status: z.enum(["open", "resolved"]).default("open"),
    site: z.string().trim().min(1).max(80),
    url: HttpUrl,
    quote: z.string().trim().min(1).max(4000),
    location: z.string().trim().min(1).max(500),
    trueToday: z.string().trim().min(1).max(4000),
    evidence: z.array(z.object({ label: z.string().trim().min(1).max(120), ref: EvidenceRef }).strict()).min(1).max(12),
    makeTrue: z.object({ tc: z.array(z.string().regex(/^TC-[1-9][0-9]*$/)).max(4).optional(), effort: z.string().trim().min(1).max(400).nullable().optional() }).strict(),
    severity: z.enum(["low", "med", "high"]),
  })
  .strict();

export const HOLD_RELEASERS = ["sam", "engineering", "upstream", "other"] as const;
export type HoldReleaser = (typeof HOLD_RELEASERS)[number];
/**
 * A freeze or hold: something stopped on purpose. The standing rule: no hold without a named owner, a
 * stated cause and an exit condition, so all three are required. `unblockedBy` points at what lifts it;
 * the page turns those pointers around into each card's "Unblocks" line.
 */
/** The longest reason Sam can send with a lift or a clear. */
export const REQUEST_REASON_MAX = 300;

export const HoldSchema = z
  .object({
    ...common,
    owner: z.string({ required_error: "owner is missing: the officer who owns this hold (the standing rule: no hold without an owner, a cause and an exit)" }).pipe(Name),
    kind: z.literal("hold"),
    status: z.enum(["active", "lifted"]).default("active"),
    /** The held thing. */
    what: z.string({ required_error: "what is missing: the held thing" }).trim().min(1, "what is missing: the held thing").max(300),
    decidedBy: z.string().trim().min(1).max(60).optional(),
    decidedAt: Iso.optional(),
    /** Sam's own words, verbatim, when it is his decision. */
    samWords: z.string().trim().min(1).max(1200).optional(),
    cause: z.string({ required_error: "cause is missing: why it is held (the standing rule: no hold without an owner, a cause and an exit)" }).trim().min(1, "cause is missing: why it is held").max(600),
    exit: z.string({ required_error: "exit is missing: the exact condition that lifts it (the standing rule: no hold without an owner, a cause and an exit)" }).trim().min(1, "exit is missing: the exact condition that lifts it").max(600),
    /** An ISO time, or a marker such as "unknown: upstream". */
    expectedRelease: z.string().trim().min(1).max(120).optional(),
    releasedBy: z.enum(HOLD_RELEASERS).default("other"),
    unblockedBy: z.array(DepRef).max(12).default([]),
    /** "any": the hold lifts when ANY of unblockedBy is done (alternatives). Absent = all of them. Optional with no default, so an older strict reader still accepts every hold that does not use it. */
    unblockedByMode: z.literal("any").optional(),
    /** Blockers Sam marked cleared (the sitrep's "Cleared" button), written only by the watcher. A cleared ref counts as done, in either mode. Optional with no default, as unblockedByMode. */
    clearedRefs: z.array(z.object({ ref: DepRef, by: z.literal("sam"), at: Iso, reason: z.string().trim().min(1).max(REQUEST_REASON_MAX).optional() }).strict()).max(12).optional(),
    liftedAt: Iso.optional(),
    liftReason: z.string().trim().min(1).max(600).optional(),
    /** Who lifted it (roci-board hold lift --from). */
    liftedBy: Name.optional(),
  })
  .strict()
  .superRefine((hold, ctx) => {
    if ((hold.status === "lifted") !== (hold.liftedAt !== undefined)) ctx.addIssue({ code: "custom", path: ["liftedAt"], message: "liftedAt goes with status lifted, and only with it" });
    if (hold.status === "lifted" && !hold.liftReason) ctx.addIssue({ code: "custom", path: ["liftReason"], message: "liftReason is missing: say why it was lifted (--reason)" });
    if (hold.status !== "lifted" && hold.liftedBy !== undefined) ctx.addIssue({ code: "custom", path: ["liftedBy"], message: "liftedBy goes with status lifted, and only with it" });
    if (hold.unblockedByMode === "any" && hold.unblockedBy.length < 2) ctx.addIssue({ code: "custom", path: ["unblockedByMode"], message: "unblockedByMode any needs at least two unblockedBy refs (alternatives)" });
    if (hold.unblockedBy.includes(`hold:${hold.id}`)) ctx.addIssue({ code: "custom", path: ["unblockedBy"], message: "a hold cannot be unblocked by itself" });
  });

/** Officer-owned tracked work. Sam's star is a separate state/progress/<id>.json priority override. */
export const ProgressSchema = z.object({
  ...common,
  kind: z.literal("progress"),
  owner: Name,
  updaters: z.array(z.string().uuid()).max(5).refine((ids) => new Set(ids).size === ids.length, "updaters must be unique").optional(),
  ticket: z.string().trim().max(100).regex(/^(?:TC-[1-9][0-9]*|(?:[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*#[1-9][0-9]*)$/, "use TC-123 or repo#123").refine((ticket) => ticket.startsWith("TC-") || resolveRepo(ticket.slice(0, ticket.indexOf("#"))) !== null, "use a known short repo or owner/repo#123"),
  steps: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    state: z.enum(["todo", "in-progress", "review", "live"]),
  }).strict()).min(1).max(24),
  currentStep: z.number().int().min(0),
  eta: Iso.optional(),
  note: z.string().trim().min(1).max(200).refine((note) => !/[\r\n]/.test(note), "note must be one line").optional(),
  updatedBy: z.string().trim().min(1).max(120).refine((name) => !/[\r\n]/.test(name), "updater name must be one line").optional(),
  important: z.boolean(),
  status: z.enum(["open", "closed"]),
}).strict().superRefine((progress, ctx) => {
  if (progress.currentStep >= progress.steps.length) ctx.addIssue({ code: "custom", path: ["currentStep"], message: "current step must be within steps (zero-based)" });
  if (progress.status === "closed" && !progress.closedAt) ctx.addIssue({ code: "custom", path: ["closedAt"], message: "closed progress requires closedAt" });
  if (progress.status === "open" && progress.closedAt) ctx.addIssue({ code: "custom", path: ["closedAt"], message: "open progress cannot have closedAt" });
});

export const RECORD_SCHEMAS = {
  ask: AskSchema,
  task: TaskSchema,
  approval: ApprovalSchema,
  incident: IncidentSchema,
  work: WorkSchema,
  ship: ShipSchema,
  order: OrderSchema,
  claim: ClaimSchema,
  hold: HoldSchema,
  progress: ProgressSchema,
} as const;

export type Ask = z.infer<typeof AskSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type Approval = z.infer<typeof ApprovalSchema>;
export type Incident = z.infer<typeof IncidentSchema>;
export type Work = z.infer<typeof WorkSchema>;
export type Ship = z.infer<typeof ShipSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Hold = z.infer<typeof HoldSchema>;
export type Progress = z.infer<typeof ProgressSchema>;
export type BoardRecord = Ask | Task | Approval | Incident | Work | Ship | Order | Claim | Hold | Progress;
export type RecordOf<K extends Kind> = Extract<BoardRecord, { kind: K }>;

/** Statuses that take a record off the live board. */
export const CLOSED_STATUSES: Record<Kind, readonly string[]> = {
  ask: ["answered", "dropped", "stale", "superseded", "expired"],
  task: ["done", "n/a", "expired"],
  approval: ["done", "cancelled", "expired"],
  incident: ["resolved"],
  work: ["done"],
  ship: ["rolled-back"],
  order: ["retired"],
  claim: ["resolved"],
  hold: ["lifted"],
  progress: ["closed"],
};

/** What `roci-board close <kind> <id>` sets when no --status is given. */
export const DEFAULT_CLOSE_STATUS: Record<Kind, string> = {
  ask: "answered",
  task: "done",
  approval: "done",
  incident: "resolved",
  work: "done",
  ship: "rolled-back",
  order: "retired",
  claim: "resolved",
  hold: "lifted",
  progress: "closed",
};

/** Ships and orders are a log: once written, only their status may change. */
export const APPEND_ONLY: readonly Kind[] = ["ship", "order"];

export const isClosed = (record: BoardRecord): boolean => CLOSED_STATUSES[record.kind].includes(record.status);

// ── Sam's records ────────────────────────────────────────────────────

/** answer/drop/accept-default answer an ask; code pastes an approval's code; done says Sam did his part of an approval. */
export const ANSWER_ACTIONS = ["answer", "drop", "accept-default", "code", "done"] as const;
export type AnswerAction = (typeof ANSWER_ACTIONS)[number];

const TEXT_MAX = 4000;
/** OpenKey's short code is 8 characters; an old CLI's full delegation code is 7–10 KB. */
export const CODE_MAX = 12000;

export const AnswerSchema = z
  .object({
    /** The ask, or the approval, this answers. */
    askId: Id,
    action: z.enum(ANSWER_ACTIONS),
    choice: ShortId.optional(),
    text: z.string().max(CODE_MAX).default(""),
    at: Iso,
    /** Answers sent together ("Answer several", "Accept all") share a batch id. */
    batch: z.string().max(40).optional(),
    /** A go answer: the card's issuedAt Sam saw; a card re-issued since then makes it stale. */
    issuedAt: Iso.optional(),
  })
  .strict()
  .superRefine((answer, ctx) => {
    if (answer.action === "answer" && !answer.choice && !answer.text.trim()) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "an answer needs a choice or some text" });
    }
    if (answer.action === "accept-default" && !answer.choice) {
      ctx.addIssue({ code: "custom", path: ["choice"], message: "accepting the recommendation names the option" });
    }
    if (answer.action === "code" && !/^\S{4,}$/.test(answer.text)) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "a code is at least 4 characters, without spaces" });
    }
    if (answer.action !== "code" && answer.text.length > TEXT_MAX) {
      ctx.addIssue({ code: "custom", path: ["text"], message: `keep it under ${TEXT_MAX} characters` });
    }
  });
export type Answer = z.infer<typeof AnswerSchema>;

/** How many of Sam's snoozes a state record keeps (the newest). */
export const SNOOZE_HISTORY_MAX = 20;
/** Count and UTF-8 byte limits for Sam's notes; the writer refuses a note past either limit. */
export const NOTE_HISTORY_MAX = 100;
export const NOTE_HISTORY_BYTES_MAX = 32 * 1024;
const noteEncoder = new TextEncoder();
/** UTF-8 bytes of the stored notes array, including JSON syntax. */
export function noteBytes(notes: readonly { id?: string; at: string; text: string }[]): number {
  return noteEncoder.encode(JSON.stringify(notes)).length;
}
/** A note's length limit: what the watcher relays in full (shared/agent-text.ts AGENT_TEXT_MAX). */
export const NOTE_TEXT_MAX = 500;

/** A stable id for a note that has none: the same note always gets the same one. */
export function noteIdFor(at: string, text: string): string {
  let a = 0xdeadbeef;
  let b = 0x41c6ce57;
  for (const ch of `${at}\n${text}`) {
    const code = ch.codePointAt(0)!;
    a = Math.imul(a ^ code, 2654435761);
    b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `n${(b >>> 0).toString(36).padStart(7, "0")}${(a >>> 0).toString(36).padStart(7, "0")}`;
}

/** How many of Sam's blocker-clear requests a hold's state record keeps (the newest). */
export const CLEAR_HISTORY_MAX = 20;
/** A reason on a lift or clear request: plain text the watcher relays to the owner, never a secret. */
const sendReason = z
  .string()
  .trim()
  .min(1)
  .max(REQUEST_REASON_MAX)
  .refine((text) => findSecrets(text).length === 0, "a reason cannot carry a secret or an approval link")
  .optional();

export const SamStateSchema = z
  .object({
    kind: z.enum(KINDS),
    id: z.string(),
    seenAt: Iso.optional(),
    dismissedAt: Iso.optional(),
    /** Task step id → when Sam ticked it (null once unticked). */
    steps: z.record(ShortId, Iso.nullable()).default({}),
    /** "Ask me later": the card is off the main lists until then. null once Sam unsnoozes or clears the "back" marker. */
    snoozedUntil: Iso.nullable().optional(),
    /** Every snooze Sam set, oldest first; append-only, the last SNOOZE_HISTORY_MAX kept. Not an answer. */
    snoozes: z.array(z.object({ at: Iso, until: Iso }).strict()).max(SNOOZE_HISTORY_MAX).optional(),
    /** Free-text updates Sam sent the card's owner ("Note to owner"), oldest first. Not an answer: the card stays as it is. */
    notes: z
      .array(
        z
          .object({
            /** Names the note for the watcher's delivery record; clocks and devices cannot make two the same. */
            id: z.string().regex(/^[a-z0-9]{8,32}$/, "a note id: 8–32 lowercase letters or digits").optional(),
            at: Iso,
            text: z.string().trim().min(1, "say something").max(NOTE_TEXT_MAX, `keep a note under ${NOTE_TEXT_MAX} characters`),
          })
          .strict()
          .superRefine((note, ctx) => {
            const hit = findSecrets(note.text)[0];
            if (hit) ctx.addIssue({ code: "custom", path: ["text"], message: `a note cannot carry ${hit.reason}; say where to find it instead` });
          })
          // A note without an id still reads: the id is a stable hash of what it says and when, so one such note never invalidates the record.
          .transform((note) => ({ ...note, id: note.id ?? noteIdFor(note.at, note.text) })),
      )
      .max(NOTE_HISTORY_MAX)
      .refine((notes) => noteBytes(notes) <= NOTE_HISTORY_BYTES_MAX, `keep notes under ${NOTE_HISTORY_BYTES_MAX} bytes`)
      .optional(),
    /** Tasks: Sam marked it done. dismissedAt is set with it, so the task leaves every list; the watcher tells the owner and closes the record. */
    doneAt: Iso.optional(),
    /** Sam's own priority on this card (docs/SPEC-priority.md): on pins it with his reason; off clears an officer's flag until he turns it on again. */
    priority: z.object({ on: z.boolean(), at: Iso }).strict().optional(),
    /** Holds only: Sam asks to lift the whole hold. The watcher lifts it once per `at`; a later tap has a new `at`. */
    lift: z.object({ at: Iso, reason: sendReason }).strict().optional(),
    /** Holds only: Sam asks to mark single blockers (refs of the hold's unblockedBy) cleared. Append-only, the last CLEAR_HISTORY_MAX kept; `id` names the request for the watcher's record. */
    clears: z.array(z.object({ id: z.string().regex(/^[a-z0-9]{8,32}$/), ref: DepRef, at: Iso, reason: sendReason }).strict()).max(CLEAR_HISTORY_MAX).optional(),
    updatedAt: Iso,
  })
  .strict()
  .superRefine((state, ctx) => {
    if (!validRecordId(state.kind, state.id)) ctx.addIssue({ code: "custom", path: ["id"], message: "invalid id for this kind" });
    if (state.kind !== "hold" && (state.lift !== undefined || state.clears !== undefined)) ctx.addIssue({ code: "custom", path: [state.lift !== undefined ? "lift" : "clears"], message: "lift and clears belong on a hold's state record" });
  });
export const ClaimDecisionSchema = z.object({
  choice: z.enum(["keep", "remove", "ignore"]),
  note: z.string().trim().min(1).max(4000).optional(),
  at: Iso,
}).strict();
export type ClaimDecision = z.infer<typeof ClaimDecisionSchema>;
export type SamState = z.infer<typeof SamStateSchema>;

/** Sam's group priority decisions (docs/SPEC-priority.md): on pins the group, off unpins it even when a member is priority. */
export const GROUP_PRIORITY_MAX = 500;
export const GroupPrioritySchema = z
  .object({
    groups: z.record(GroupName, z.object({ on: z.boolean(), at: Iso }).strict()).default({}),
    updatedAt: Iso,
  })
  .strict()
  .refine((prefs) => Object.keys(prefs.groups).length <= GROUP_PRIORITY_MAX, `keep at most ${GROUP_PRIORITY_MAX} group decisions`);
export type GroupPriority = z.infer<typeof GroupPrioritySchema>;

// ── Keys ─────────────────────────────────────────────────────────────

export const boardKey = (kind: Kind, id: string): string => `${BOARD_PREFIX}${kind}/${id}.json`;
export const boardKindPrefix = (kind: Kind): string => `${BOARD_PREFIX}${kind}/`;
export const stateKey = (kind: Kind, id: string): string => `${STATE_PREFIX}${kind}/${id}.json`;

/** 2026-10-13T15:42:00.123Z → 20261013T154200123Z: sorts like time and keeps keys free of ':' and '.'. */
export function compactStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error(`not a timestamp: ${iso}`);
  return date.toISOString().replace(/[-:.]/g, "");
}

export function stampToIso(stamp: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(stamp);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`;
  const date = new Date(iso);
  return !Number.isNaN(date.getTime()) && date.toISOString() === iso ? iso : null;
}

export const answerKey = (askId: string, at: string): string => `${ANSWERS_PREFIX}${askId}/${compactStamp(at)}.json`;
/** A random 32-hex nonce keeps independent browser views from overwriting one another. */
export const claimDecisionKey = (claimId: string, at: string, nonce: string): string => `${CLAIMS_PREFIX}${claimId}/${compactStamp(at)}-${nonce}.json`;
export const samChatKey = (at: string): string => `${SAM_CHAT_PREFIX}${compactStamp(at)}.json`;
export const boardChatKey = (at: string): string => `${BOARD_CHAT_PREFIX}${compactStamp(at)}.json`;

// ── Interviews ───────────────────────────────────────────────────────

/** A Paseo agent id: interviewers are addressed by id, never by name. */
export const AGENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const INTERVIEW_REPLY_MAX = 4000;
/** One interviewer or Sam message as published; longer ones are cut with "…". */
export const INTERVIEW_MESSAGE_MAX = 8000;
export const INTERVIEW_SUMMARY_MAX = 48_000;
export const INTERVIEW_STATUSES = ["not-open", "not-started", "in-progress", "done"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/** Sam's reply to an interviewer: relayed verbatim, exactly once, by the watcher. */
export const InterviewReplySchema = z.object({
  text: z.string().trim().min(1, "say something").max(INTERVIEW_REPLY_MAX, `keep a reply under ${INTERVIEW_REPLY_MAX} characters`)
    .refine((text) => !findSecrets(text).length, "this looks like a secret or an approval link; don't send it to an interviewer"),
  at: Iso,
}).strict();
export type InterviewReply = z.infer<typeof InterviewReplySchema>;
export const interviewReplyKey = (agentId: string, at: string, nonce: string): string => `${SAM_INTERVIEW_PREFIX}${agentId}/${compactStamp(at)}-${nonce}.json`;

const InterviewText = z.string().max(INTERVIEW_MESSAGE_MAX);

/** The watcher's view of one step of the sam-interviews task: board/interview/<step>.json. */
export const InterviewSchema = z.object({
  step: Id,
  /** Position in the task's steps, from 0. */
  order: z.number().int().min(0).max(99),
  title: z.string().trim().min(1).max(200),
  /** The task step's own text. */
  note: z.string().max(600),
  status: z.enum(INTERVIEW_STATUSES),
  /** The interviewer wearing rocinante.interview=<step>, absent when none is live. */
  agentId: z.string().regex(AGENT_ID_RE).optional(),
  /** The interviewer's latest message to Sam: the current question. */
  question: z.object({ text: InterviewText, at: Iso }).strict().optional(),
  /** The question/answer exchanges, oldest first; never homework or notes. */
  exchanges: z.array(z.object({ who: z.enum(["interviewer", "sam"]), text: InterviewText, at: Iso }).strict()).max(200),
  /** Older exchanges were left out to keep the record small. */
  truncated: z.boolean(),
  /** summary.md once it exists, with notes blocks dropped. */
  summary: z.string().max(INTERVIEW_SUMMARY_MAX).optional(),
  /** What became of Sam's latest replies to this interviewer, by key suffix (<stamp>-<nonce>). */
  replies: z.array(z.object({ id: z.string().regex(/^\d{8}T\d{9}Z-[0-9a-f]{32}$/), state: z.enum(["delivered", "unconfirmed", "refused"]) }).strict()).max(50),
  updatedAt: Iso,
}).strict();
export type Interview = z.infer<typeof InterviewSchema>;
export const interviewKey = (step: string): string => `${INTERVIEW_PREFIX}${step}.json`;

// ── The XO thread ────────────────────────────────────────────────────

const ChatText = z.string().trim().min(1, "say something").max(TEXT_MAX);

/** Sam's message to the XO, from the "Talk to the XO" panel. */
export const SamChatSchema = z.object({ text: ChatText, at: Iso }).strict();
export type SamChat = z.infer<typeof SamChatSchema>;

/** An officer's deliberate reply in Sam's thread (roci-board chat). */
export const OfficerChatSchema = z
  .object({
    from: Name,
    text: ChatText,
    at: Iso,
    /** The `at` of Sam's message this answers. */
    replyTo: Iso.optional(),
  })
  .strict();
export type OfficerChat = z.infer<typeof OfficerChatSchema>;

/** Written by the watcher: every Sam message up to this time has reached the XO. */
export const ChatReceiptSchema = z.object({ deliveredThrough: Iso, updatedAt: Iso }).strict();
export type ChatReceipt = z.infer<typeof ChatReceiptSchema>;

export type ParsedKey =
  | { area: "board"; kind: Kind; id: string }
  | { area: "answer"; askId: string; stamp: string; at: string }
  | { area: "claim-decision"; id: string; stamp: string; at: string }
  | { area: "state"; kind: Kind; id: string }
  | { area: "chat"; side: "sam" | "board"; stamp: string; at: string }
  | { area: "receipt" }
  | { area: "interview"; step: string }
  | { area: "interview-reply"; agentId: string; id: string; at: string }
  | { area: "prefs"; name: "group-priority" };

/** Reads a full KV key back into what it addresses; null for anything outside the layout. */
export function parseKey(key: string): ParsedKey | null {
  if (key === CHAT_RECEIPT_KEY) return { area: "receipt" };
  let match = /^xyz\.tinycloud\.rocinante\/board\/interview\/([^/]+)\.json$/.exec(key);
  if (match) return ID_RE.test(match[1]!) ? { area: "interview", step: match[1]! } : null;
  match = /^xyz\.tinycloud\.rocinante\/sam\/interview\/([^/]+)\/(\d{8}T\d{9}Z)-([0-9a-f]{32})\.json$/.exec(key);
  if (match) {
    const [, agentId, stamp, nonce] = match;
    const at = stampToIso(stamp!);
    return at && AGENT_ID_RE.test(agentId!) ? { area: "interview-reply", agentId: agentId!, id: `${stamp}-${nonce}`, at } : null;
  }
  match = /^xyz\.tinycloud\.rocinante\/(sam|board)\/chat\/([^/]+)\.json$/.exec(key);
  if (match) {
    const [, side, stamp] = match;
    const at = stampToIso(stamp!);
    return at ? { area: "chat", side: side as "sam" | "board", stamp: stamp!, at } : null;
  }
  match = /^xyz\.tinycloud\.rocinante\/board\/([a-z]+)\/([^/]+)\.json$/.exec(key);
  if (match) {
    const [, kind, id] = match;
    return isKind(kind) && validRecordId(kind, id!) ? { area: "board", kind, id: id! } : null;
  }
  match = /^xyz\.tinycloud\.rocinante\/sam\/claims\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (match) {
    const [, claimId, stamp] = match;
    const time = /^(\d{8}T\d{9}Z)-[0-9a-f]{32}$/.exec(stamp!);
    const at = time ? stampToIso(time[1]!) : null;
    return at && validRecordId("claim", claimId!) ? { area: "claim-decision", id: claimId!, stamp: stamp!, at } : null;
  }
  match = /^xyz\.tinycloud\.rocinante\/sam\/answers\/([^/]+)\/([^/]+)\.json$/.exec(key);
  if (match) {
    const [, askId, stamp] = match;
    const at = stampToIso(stamp!);
    return at && ID_RE.test(askId!) ? { area: "answer", askId: askId!, stamp: stamp!, at } : null;
  }
  match = /^xyz\.tinycloud\.rocinante\/sam\/state\/([a-z]+)\/([^/]+)\.json$/.exec(key);
  if (match) {
    const [, kind, id] = match;
    return isKind(kind) && validRecordId(kind, id!) ? { area: "state", kind, id: id! } : null;
  }
  if (key === GROUP_PRIORITY_KEY) return { area: "prefs", name: "group-priority" };
  return null;
}

// ── Validation ───────────────────────────────────────────────────────

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function issues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(record)";
    return issue.message.startsWith(path) || issue.message.startsWith("context") ? issue.message : `${path}: ${issue.message}`;
  });
}

export function validateRecord(kind: Kind, input: unknown): Validation<BoardRecord> {
  const result = RECORD_SCHEMAS[kind].safeParse(input);
  return result.success ? { ok: true, value: result.data as BoardRecord } : { ok: false, errors: issues(result.error) };
}

export function validateAnswer(input: unknown): Validation<Answer> {
  const result = AnswerSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateState(input: unknown): Validation<SamState> {
  const result = SamStateSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateGroupPriority(input: unknown): Validation<GroupPriority> {
  const result = GroupPrioritySchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateClaimDecision(input: unknown): Validation<ClaimDecision> {
  const result = ClaimDecisionSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateSamChat(input: unknown): Validation<SamChat> {
  const result = SamChatSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateOfficerChat(input: unknown): Validation<OfficerChat> {
  const result = OfficerChatSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateChatReceipt(input: unknown): Validation<ChatReceipt> {
  const result = ChatReceiptSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateInterview(input: unknown): Validation<Interview> {
  const result = InterviewSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}

export function validateInterviewReply(input: unknown): Validation<InterviewReply> {
  const result = InterviewReplySchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, errors: issues(result.error) };
}
