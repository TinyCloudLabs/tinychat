/**
 * The decision half of the Settings background-notifications surface.
 *
 * `BackgroundSyncSection.tsx` renders this; it decides nothing on its own. The
 * split exists because every rule the handoff states about this surface is a
 * rule about a STATE, and a state machine can be pinned by test where a React
 * tree in a workspace with no DOM harness cannot:
 *
 *  - a route-disabled `404` is `dark`: a defined product state in which the
 *    control does not render at all — never a broken-looking button;
 *  - a `503`/network failure is `unavailable` with a retry, never `off` and
 *    never an empty queue (§"backend/config outages … never false empty");
 *  - `surfaceBlocked`, a tripped delivery rate limit, and a dead-letter are
 *    DISTINCT notices; none of them collapses into "nothing waiting";
 *  - a minted config is "Enabled in TinyChat". Never "Live" — minting a
 *    credential is not evidence that a provider delivery has ever arrived,
 *    which is exactly the claim Listen's UI makes and gets wrong;
 *  - the delivery URL and secret exist ONLY inside `reveal`, only between a
 *    mint/rotate response and the user closing it. Nothing here persists,
 *    logs, or re-fetches them — `GET /config` cannot bring them back, so
 *    losing them means rotating;
 *  - MOUNT NEVER UNLOCKS. `loadOnMount` may process automatically when the
 *    vault is *already* open, and otherwise only counts what is waiting.
 *    `secrets.unlock()` is reachable from exactly one place: the user-initiated
 *    `syncQueuedMeetings`.
 *
 * Option C, restated: the backend queues `(meetingId, kind)` and nothing else.
 * The Fireflies key and every write to the user's space belong to the browser —
 * this module never touches the key, and hands the ids to FE2's
 * `ingestQueuedMeetings` which does.
 */

import {
  readSurfaceBlocked,
  type ConnectorSurfaceBlockedReason,
  type ConnectorWebhookConfigPoll,
  type ConnectorWebhookDisabled,
  type ConnectorWebhookEnabled,
  type ConnectorWebhookPending,
  type ConnectorWebhooksResult,
} from "@/lib/connectors/webhooksApi";
import type {
  TargetedIngestBlockedReason,
  TargetedIngestOutcome,
  TargetedIngestResult,
  TargetedQueueItem,
} from "@/lib/connectors/targetedSync";
import type { ConnectorConnection, ConnectorDescriptor } from "@/lib/connectors/types";

/**
 * Whether a connectors-card row may offer this surface at all.
 *
 * Two conditions, both deliberate. The connector must be CONNECTED, because the
 * browser needs its key to collect anything a notification announces — the two
 * states stay separate and background notifications never stand in for
 * connecting. And the source must be one the public delivery route accepts:
 * v1 registers Fireflies only, so a `coming-soon` connector flipping to
 * `available` cannot start advertising a webhook the backend would reject.
 *
 * It lives here rather than in the card because it is a rule, and rules in this
 * feature are tested.
 */
export function supportsBackgroundNotifications(
  descriptor: ConnectorDescriptor,
  connection: ConnectorConnection | null,
): boolean {
  return descriptor.id === "fireflies" && connection?.status === "connected";
}

/** The status word for a minted config. Deliberately not "Live" — see the header. */
export const BACKGROUND_SYNC_ENABLED_LABEL = "Enabled in TinyChat";

export type BackgroundSyncPhase =
  /** The first `GET /config` is in flight; the surface claims nothing yet. */
  | "loading"
  /** `404` — the companion router is not mounted. Render nothing at all. */
  | "dark"
  /** `401` — the session went away underneath us. */
  | "signed-out"
  /** A retryable/network failure. NOT "off": we do not know the real state. */
  | "unavailable"
  | "off"
  | "enabled";

export type BackgroundSyncBusy =
  | null
  | "loading"
  | "enabling"
  | "rotating"
  | "disabling"
  | "syncing"
  | "clearing-ledger";

/** The one-time pair. Lives in component state for as long as it is displayed. */
export interface RevealedCredentials {
  url: string;
  secret: string;
  /** True when this pair REPLACED a working one, which the copy has to say. */
  rotated: boolean;
}

export interface BackgroundSyncQueue {
  pendingCount: number;
  deadCount: number;
  rateLimited: boolean;
  /** The fail-closed surfacing gate. `"unknown"` for a reason this bundle predates. */
  blockedReason: ConnectorSurfaceBlockedReason | "unknown" | null;
}

export interface BackgroundSyncNotice {
  tone: "error" | "info";
  message: string;
  /** True when repeating the SAME action is the correct next step. */
  retryable: boolean;
}

/** What the last processing run did — counts only, never a meeting identifier. */
export interface IngestSummary {
  stored: number;
  acknowledged: number;
  alreadySettled: number;
  tombstoned: number;
  failed: number;
  unacknowledged: number;
}

export interface BackgroundSyncState {
  phase: BackgroundSyncPhase;
  /** From the poll: a secret EXISTS. Its value is unreadable after the mint. */
  hasSecret: boolean;
  createdAt: string | null;
  reveal: RevealedCredentials | null;
  /** A reveal has been shown and closed (or never carried a secret): offer rotate. */
  revealClosed: boolean;
  queue: BackgroundSyncQueue | null;
  /** The queue read itself failed. `queue` stays null: no count is invented. */
  queueUnavailable: boolean;
  busy: BackgroundSyncBusy;
  notice: BackgroundSyncNotice | null;
  lastIngest: IngestSummary | null;
  ingestBlocked: TargetedIngestBlockedReason | null;
  /**
   * The user has ASKED to allow historical re-sync and is being shown what it
   * means. `DELETE /purged` is reachable from nowhere else — see
   * {@link confirmHistoricalResync}.
   */
  resyncConfirming: boolean;
}

export function initialBackgroundSyncState(): BackgroundSyncState {
  return {
    phase: "loading",
    hasSecret: false,
    createdAt: null,
    reveal: null,
    revealClosed: false,
    queue: null,
    queueUnavailable: false,
    busy: null,
    notice: null,
    lastIngest: null,
    ingestBlocked: null,
    resyncConfirming: false,
  };
}

// ── Dependencies ─────────────────────────────────────────────────────

/** The FE0 client's methods this surface uses. Nothing else reaches the network. */
export interface BackgroundSyncWebhooks {
  getConfig(): Promise<ConnectorWebhooksResult<ConnectorWebhookConfigPoll>>;
  enable(options?: {
    source?: string;
    rotate?: boolean;
  }): Promise<ConnectorWebhooksResult<ConnectorWebhookEnabled>>;
  disable(): Promise<ConnectorWebhooksResult<ConnectorWebhookDisabled>>;
  getPending(): Promise<ConnectorWebhooksResult<ConnectorWebhookPending>>;
  drain(): Promise<ConnectorWebhooksResult<ConnectorWebhookPending>>;
  /**
   * `DELETE /purged`. The ONE destructive-to-privacy call on this surface, and
   * the only thing that lets meetings the user deleted come back. It is called
   * from exactly one place — {@link confirmHistoricalResync} — and never as a
   * side effect of connecting, enabling, rotating or syncing.
   */
  clearPurgeLedger(source: string): Promise<ConnectorWebhooksResult<null>>;
}

/**
 * The vault. `unlock` is present because ONE user-initiated action may perform
 * it; `loadOnMount` never calls it, and that is asserted by test.
 */
export interface BackgroundSyncSecrets {
  isUnlocked(): boolean;
  unlock(): Promise<{ ok: true } | { ok: false; error?: { message?: string } }>;
}

export interface BackgroundSyncDeps {
  /** The connector's SQL/source name — the only thing `POST /config` is told. */
  source: string;
  webhooks: BackgroundSyncWebhooks;
  secrets: BackgroundSyncSecrets;
  /** FE2's `ingestQueuedMeetings`, bound to this connector. The only writer. */
  ingest(items: readonly TargetedQueueItem[]): Promise<TargetedIngestResult>;
}

export type BackgroundSyncEmit = (
  updater: (prev: BackgroundSyncState) => BackgroundSyncState,
) => void;

// ── Pure reducers ────────────────────────────────────────────────────

/** A `GET /config` poll. Never restores a reveal: the secret is gone for good. */
export function applyConfigPoll(
  state: BackgroundSyncState,
  config: ConnectorWebhookConfigPoll,
): BackgroundSyncState {
  return {
    ...state,
    phase: config.enabled ? "enabled" : "off",
    hasSecret: config.enabled && config.hasSecret,
    createdAt: config.createdAt,
    // `url` is deliberately dropped: it is password-like, and outside the
    // one-time reveal there is no reason for it to sit in a rendered tree.
    notice: null,
    ...(config.enabled
      ? {}
      : { queue: null, queueUnavailable: false, lastIngest: null, ingestBlocked: null }),
  };
}

/** A mint or rotate. The ONE place a `reveal` is ever created. */
export function applyEnableResult(
  state: BackgroundSyncState,
  value: ConnectorWebhookEnabled,
): BackgroundSyncState {
  const revealed =
    typeof value.secret === "string" && value.secret.length > 0 && value.url
      ? { url: value.url, secret: value.secret, rotated: value.rotated }
      : null;
  return {
    ...state,
    phase: "enabled",
    hasSecret: value.hasSecret,
    createdAt: value.createdAt,
    reveal: revealed,
    // A response that carried no secret is already "closed": there is nothing
    // to show, so the recovery path (rotate) is what the user needs offered.
    revealClosed: revealed === null,
    notice:
      revealed === null
        ? {
            tone: "info",
            message:
              "Background notifications are already set up. The signing secret is only shown once — rotate it if you no longer have it.",
            retryable: false,
          }
        : null,
  };
}

/** The user closed the reveal. The values are dropped, not hidden. */
export function dismissReveal(state: BackgroundSyncState): BackgroundSyncState {
  return { ...state, reveal: null, revealClosed: true };
}

export function applyQueueSnapshot(
  state: BackgroundSyncState,
  snapshot: ConnectorWebhookPending,
): BackgroundSyncState {
  const blocked = readSurfaceBlocked(snapshot);
  // `/pending` and `/drain` carry the authoritative enabled flag, so a config
  // torn down on another device corrects this surface instead of leaving a
  // stale "Enabled in TinyChat" behind. `dark`/`signed-out` outrank it: those
  // are statements about the route and the session, not about the config.
  const phase: BackgroundSyncPhase =
    state.phase === "dark" || state.phase === "signed-out"
      ? state.phase
      : snapshot.enabled
        ? "enabled"
        : "off";
  return {
    ...state,
    phase,
    queueUnavailable: false,
    queue: {
      pendingCount: snapshot.count,
      deadCount: snapshot.deadCount,
      rateLimited: snapshot.deliveriesRateLimited,
      blockedReason: blocked.blocked ? blocked.reason : null,
    },
  };
}

export function applyIngestOutcome(
  state: BackgroundSyncState,
  outcome: TargetedIngestOutcome,
): BackgroundSyncState {
  const summary: IngestSummary = {
    stored: outcome.stored,
    acknowledged: outcome.acknowledged,
    alreadySettled: outcome.alreadySettled,
    tombstoned: outcome.tombstoned,
    failed: outcome.failures.length,
    unacknowledged: outcome.unacknowledged.length,
  };
  let notice: BackgroundSyncNotice | null = null;
  if (summary.unacknowledged > 0) {
    // Safe, and explicitly NOT an error: the meetings are in the space. The
    // identities stay queued and the next run settles them idempotently.
    notice = {
      tone: "info",
      message: `Saved ${plural(summary.unacknowledged, "meeting")}, but the server didn't confirm. Nothing is lost — syncing again finishes the job.`,
      retryable: true,
    };
  } else if (summary.failed > 0) {
    notice = {
      tone: "info",
      message: `${plural(summary.failed, "meeting")} couldn't be collected and stayed queued. Try syncing again in a few minutes.`,
      retryable: true,
    };
  }
  return { ...state, lastIngest: summary, ingestBlocked: outcome.blocked, notice };
}

/** Turn a non-`ok` client result into a phase/notice. Carries no identifier. */
export function failureNotice(
  result: Exclude<ConnectorWebhooksResult<never>, { status: "ok" }>,
): BackgroundSyncNotice | null {
  switch (result.status) {
    case "feature-dark":
    case "unauthenticated":
      // Both are phases, not messages: a dark surface renders nothing and a
      // signed-out one says so structurally.
      return null;
    case "offline":
      return {
        tone: "error",
        message: "Couldn't reach the server. Check your connection and try again.",
        retryable: true,
      };
    case "retryable":
      return {
        tone: "error",
        message: `Background notifications are temporarily unavailable (${result.httpStatus}). Try again in a moment.`,
        retryable: true,
      };
    case "rejected":
      return {
        tone: "error",
        message: `The server refused that request${result.code ? ` (${result.code})` : ""}.`,
        retryable: false,
      };
  }
}

// ── Derived views ────────────────────────────────────────────────────

export interface BackgroundSyncStatus {
  label: string;
  tone: "ok" | "off" | "warn" | "muted";
}

export function backgroundSyncStatus(state: BackgroundSyncState): BackgroundSyncStatus {
  switch (state.phase) {
    case "enabled":
      // Minted, not proven receiving. See the module header.
      return { label: BACKGROUND_SYNC_ENABLED_LABEL, tone: "ok" };
    case "off":
      return { label: "Off", tone: "off" };
    case "unavailable":
      return { label: "Status unavailable", tone: "warn" };
    case "signed-out":
      return { label: "Sign in required", tone: "warn" };
    case "loading":
      return { label: "Checking…", tone: "muted" };
    case "dark":
      return { label: "", tone: "muted" };
  }
}

export type QueueNoticeKind =
  | "queue-unavailable"
  | "blocked"
  | "rate-limited"
  | "pending"
  | "dead"
  | "ingest-blocked"
  | "empty";

export interface QueueNotice {
  kind: QueueNoticeKind;
  title: string;
  detail: string;
  /** The one action that moves this state forward, if any. */
  action: "sync" | "retry" | null;
  tone: "info" | "warn";
}

const BLOCKED_DETAIL: Record<ConnectorSurfaceBlockedReason | "unknown", string> = {
  revoked:
    "Background notifications were turned off for this connector, so the queue is not being handed out.",
  ledger_unavailable:
    "We couldn't check which meetings you've deleted, so nothing is handed out until that read succeeds.",
  delegation_unusable:
    "The server refused to hand out the queue for this connector.",
  drain_aborted: "The server stopped part-way through handing out the queue.",
  drain_unreported: "The server couldn't confirm what it handed out.",
  unknown: "The server refused to hand out the queue and gave a reason this app doesn't know yet.",
};

/**
 * Every queue state worth acting on, as separate notices.
 *
 * The invariant the tests pin: `empty` is emitted ONLY when the queue was read
 * successfully and genuinely holds nothing. A refusal, an outage, a dead-letter
 * or a rate limit is never quietly folded into "nothing waiting".
 */
export function queueNotices(state: BackgroundSyncState): QueueNotice[] {
  if (state.phase !== "enabled") return [];
  const notices: QueueNotice[] = [];
  if (state.queueUnavailable) {
    notices.push({
      kind: "queue-unavailable",
      title: "Queue unavailable",
      detail:
        "We couldn't read what's waiting. Nothing has been lost — this is a read failure, not an empty queue.",
      action: "retry",
      tone: "warn",
    });
  }
  const queue = state.queue;
  if (queue) {
    if (queue.blockedReason) {
      notices.push({
        kind: "blocked",
        title: "We can't show what's waiting",
        detail: BLOCKED_DETAIL[queue.blockedReason],
        action: "retry",
        tone: "warn",
      });
    }
    if (queue.rateLimited) {
      notices.push({
        kind: "rate-limited",
        title: "Deliveries are being rate limited",
        detail:
          "Fireflies is notifying us faster than we accept for your account. Recent notifications may have been turned away and will need a re-send or a manual sync.",
        action: null,
        tone: "warn",
      });
    }
    if (queue.pendingCount > 0) {
      notices.push({
        kind: "pending",
        title: `${plural(queue.pendingCount, "meeting")} waiting`,
        detail: `Fireflies told us ${queue.pendingCount} ${queue.pendingCount === 1 ? "is" : "are"} ready. Your browser collects and saves them — that needs your Fireflies key, so it happens here.`,
        action: "sync",
        tone: "info",
      });
    }
    if (queue.deadCount > 0) {
      notices.push({
        kind: "dead",
        title: `${plural(queue.deadCount, "notification")} gave up`,
        detail:
          "These failed repeatedly and are no longer retried. Use Sync now on the connector above to pick the meetings up directly.",
        action: null,
        tone: "warn",
      });
    }
  }
  if (state.ingestBlocked) {
    notices.push({
      kind: "ingest-blocked",
      title:
        state.ingestBlocked === "secrets-locked"
          ? "Your keys are locked"
          : "No Fireflies key on this device",
      detail:
        state.ingestBlocked === "secrets-locked"
          ? "Waiting meetings stay queued until you unlock. Nothing is unlocked without you asking for it."
          : "Reconnect Fireflies above to give this browser the key it needs to collect waiting meetings.",
      action: state.ingestBlocked === "secrets-locked" ? "sync" : null,
      tone: "warn",
    });
  }
  if (notices.length === 0 && queue) {
    notices.push({
      kind: "empty",
      title: "Nothing waiting",
      detail: "New meetings show up here as Fireflies reports them.",
      action: null,
      tone: "info",
    });
  }
  return notices;
}

// ── Actions ──────────────────────────────────────────────────────────

/**
 * The Settings-mount read.
 *
 * Reads `GET /config`; then, when background notifications are on, either
 * processes the queue (vault already open — the "next visit" of the consent
 * copy) or merely counts it. It NEVER unlocks and never drains a queue it is
 * not about to process, so a locked visit cannot burn a delivery's attempts.
 */
export async function loadOnMount(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  emit((s) => ({ ...s, busy: "loading" }));
  const result = await deps.webhooks.getConfig();
  if (result.status !== "ok") {
    emit((s) => ({
      ...s,
      busy: null,
      phase: configFailurePhase(result.status),
      queue: null,
      queueUnavailable: false,
      notice: failureNotice(result),
    }));
    return;
  }
  const config = result.value;
  emit((s) => applyConfigPoll(s, config));
  if (!config.enabled) {
    emit((s) => ({ ...s, busy: null }));
    return;
  }
  if (deps.secrets.isUnlocked()) {
    await processQueue(deps, emit);
  } else {
    await readQueue(deps, emit);
  }
  emit((s) => ({ ...s, busy: null }));
}

function configFailurePhase(
  status: Exclude<ConnectorWebhooksResult<never>, { status: "ok" }>["status"],
): BackgroundSyncPhase {
  if (status === "feature-dark") return "dark";
  if (status === "unauthenticated") return "signed-out";
  // `rejected` included: we asked the documented question and did not get an
  // answer we can read, so the honest state is "we don't know", not "off".
  return "unavailable";
}

/** Mint: `POST /config`, then reveal the pair exactly once. */
export async function enableBackgroundSync(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  await mint(deps, emit, { rotate: false });
}

/**
 * Rotate: the recovery path when the one-time secret is gone. The backend
 * revokes the old token before it answers, so a success here means the old URL
 * and secret are already dead — which is what the copy tells the user.
 */
export async function rotateCredentials(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  await mint(deps, emit, { rotate: true });
}

async function mint(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
  options: { rotate: boolean },
): Promise<void> {
  emit((s) => ({ ...s, busy: options.rotate ? "rotating" : "enabling", notice: null }));
  const result = await deps.webhooks.enable(
    options.rotate ? { source: deps.source, rotate: true } : { source: deps.source },
  );
  if (result.status !== "ok") {
    // Nothing is claimed: on a failed rotate the OLD credentials may still be
    // the live ones, so the surface must not move.
    emit((s) => ({
      ...s,
      busy: null,
      ...(result.status === "feature-dark" ? { phase: "dark" as const } : {}),
      ...(result.status === "unauthenticated" ? { phase: "signed-out" as const } : {}),
      notice: failureNotice(result),
    }));
    return;
  }
  const value = result.value;
  emit((s) => ({ ...applyEnableResult(s, value), busy: null }));
}

/**
 * `DELETE /config`. Idempotent server-side; retry the same call on failure.
 *
 * A FAILED teardown is not "nothing happened". The route writes the durable
 * disabled marker FIRST and only then revokes the token and drops the queue, so
 * a `503 teardown_incomplete` means "the marker landed, the rest may not have" —
 * the backend can already be answering `enabled:false` with
 * `surfaceBlocked:'revoked'` for this address. Leaving the last-known "Enabled
 * in TinyChat" up would tell the user notifications are on at the exact moment
 * the backend has classified them off, so the phase moves to `unavailable`: we
 * no longer know, which is what the retry copy already says. `dark` and
 * `signed-out` still outrank it — those are statements about the route and the
 * session, not about the config.
 */
export async function disableBackgroundSync(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  emit((s) => ({ ...s, busy: "disabling", notice: null }));
  const result = await deps.webhooks.disable();
  if (result.status !== "ok") {
    emit((s) => ({
      ...s,
      busy: null,
      phase: configFailurePhase(result.status),
      // No count is claimed either: the queue may or may not have been dropped.
      queue: null,
      queueUnavailable: false,
      notice: failureNotice(result),
    }));
    return;
  }
  emit((s) => ({
    ...s,
    busy: null,
    phase: "off",
    hasSecret: false,
    createdAt: null,
    reveal: null,
    revealClosed: false,
    queue: null,
    queueUnavailable: false,
    lastIngest: null,
    ingestBlocked: null,
    resyncConfirming: false,
    notice: {
      tone: "info",
      message:
        "Background notifications are off. Delete the webhook in Fireflies too — the old address stops working immediately.",
      retryable: false,
    },
  }));
}

// ── Allow historical re-sync (the ONLY ledger-clearing path) ─────────
//
// A "disconnect and delete all my meetings" leaves a purge tombstone on the
// backend. That tombstone is the reason a replayed or in-flight signed delivery
// cannot put those meetings back, and RECONNECTING MUST NOT CLEAR IT — a user
// who deleted their history and then reconnects has not asked for the history
// back. So clearing it is its own action, behind its own confirmation, and the
// three functions below are the whole of it.

/** Arm the confirmation. Performs no I/O — this step exists to be read. */
export function requestHistoricalResync(
  state: BackgroundSyncState,
): BackgroundSyncState {
  return { ...state, resyncConfirming: true, notice: null };
}

export function cancelHistoricalResync(
  state: BackgroundSyncState,
): BackgroundSyncState {
  return { ...state, resyncConfirming: false };
}

/** The copy the confirmation shows. Kept beside the action it describes. */
export const HISTORICAL_RESYNC_CONFIRM_COPY = {
  heading: "Allow deleted meetings to be collected again?",
  body:
    "We keep a record of the meetings you deleted so a late Fireflies notification cannot bring them back. Clearing that record means any of those meetings Fireflies tells us about again WILL be collected and saved to your space. Nothing else changes, and this cannot be undone.",
  confirmLabel: "Clear the record and allow re-sync",
  cancelLabel: "Keep them deleted",
} as const;

/**
 * `DELETE /purged`. Refuses unless {@link requestHistoricalResync} armed it, so
 * a stray handler cannot reach the destructive call; on failure the
 * confirmation STAYS armed and nothing claims that history is available again.
 */
export async function confirmHistoricalResync(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  let armed = false;
  emit((s) => {
    armed = s.resyncConfirming;
    return armed ? { ...s, busy: "clearing-ledger", notice: null } : s;
  });
  if (!armed) return;
  const result = await deps.webhooks.clearPurgeLedger(deps.source);
  if (result.status !== "ok") {
    emit((s) => ({
      ...s,
      busy: null,
      ...(result.status === "feature-dark" ? { phase: "dark" as const } : {}),
      ...(result.status === "unauthenticated" ? { phase: "signed-out" as const } : {}),
      notice: failureNotice(result),
    }));
    return;
  }
  emit((s) => ({
    ...s,
    busy: null,
    resyncConfirming: false,
    notice: {
      tone: "info",
      message:
        "Cleared. Meetings you previously deleted can be collected again if Fireflies reports them.",
      retryable: false,
    },
  }));
}

/** A plain `GET /pending` refresh. Never changes queue state server-side. */
export async function refreshQueue(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  await readQueue(deps, emit);
}

async function readQueue(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  const result = await deps.webhooks.getPending();
  if (result.status !== "ok") {
    emit((s) => ({
      ...s,
      ...(result.status === "feature-dark" ? { phase: "dark" as const } : {}),
      ...(result.status === "unauthenticated" ? { phase: "signed-out" as const } : {}),
      queue: null,
      queueUnavailable: true,
      notice: s.notice ?? failureNotice(result),
    }));
    return;
  }
  const snapshot = result.value;
  emit((s) => applyQueueSnapshot(s, snapshot));
}

/**
 * The user-initiated "Sync queued meetings".
 *
 * This is the ONLY path that may unlock the vault, and it does so because the
 * user asked for it by name. Everything after the unlock is the same
 * drain → ingest → refresh sequence an already-unlocked visit runs by itself.
 */
export async function syncQueuedMeetings(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  emit((s) => ({ ...s, busy: "syncing", notice: null, ingestBlocked: null }));
  if (!deps.secrets.isUnlocked()) {
    const unlocked = await deps.secrets.unlock();
    if (!unlocked.ok) {
      emit((s) => ({
        ...s,
        busy: null,
        notice: {
          tone: "error",
          message: `Couldn't unlock your keys: ${unlocked.error?.message ?? "unlock was not completed"}`,
          retryable: true,
        },
      }));
      return;
    }
  }
  await processQueue(deps, emit);
  emit((s) => ({ ...s, busy: null }));
}

/**
 * `POST /drain` is the processing trigger, so it is called only here — never as
 * a passive poll. Ids that come back are handed straight to FE2, which fetches
 * and writes with the browser-held key and acknowledges only what it stored.
 */
async function processQueue(
  deps: BackgroundSyncDeps,
  emit: BackgroundSyncEmit,
): Promise<void> {
  const drained = await deps.webhooks.drain();
  if (drained.status !== "ok") {
    emit((s) => ({
      ...s,
      ...(drained.status === "feature-dark" ? { phase: "dark" as const } : {}),
      ...(drained.status === "unauthenticated" ? { phase: "signed-out" as const } : {}),
      queue: null,
      queueUnavailable: true,
      notice: failureNotice(drained),
    }));
    return;
  }
  const snapshot = drained.value;
  emit((s) => applyQueueSnapshot(s, snapshot));
  // A refusal surfaced nothing and authorized nothing: there is no work to do
  // and the reason is already a rendered state.
  if (readSurfaceBlocked(snapshot).blocked) return;
  const items: TargetedQueueItem[] = snapshot.pending.map((item) => ({
    meetingId: item.meetingId,
    kind: item.kind,
  }));
  if (items.length === 0) return;
  const ingested = await deps.ingest(items);
  if (!ingested.ok) {
    // A terminal error still leaves work done: FE2 acknowledges everything it
    // stored before it gives up, because those meetings ARE in the space. The
    // counts of that partial run do not ride the error, so the previous run's
    // "Last collected" line is DROPPED rather than left standing beside a fresh
    // failure — a stale number is worse than none — and the queue is re-read
    // below so the count on the card is the backend's post-run truth.
    emit((s) => ({
      ...s,
      lastIngest: null,
      notice: { tone: "error", message: ingested.error.message, retryable: true },
    }));
  } else {
    emit((s) => applyIngestOutcome(s, ingested.data));
  }
  // Re-read rather than subtract: the count the card shows is the backend's,
  // and a partially acknowledged run must not be reported as a clean queue.
  const after = await deps.webhooks.getPending();
  if (after.status !== "ok") {
    emit((s) => ({ ...s, queue: null, queueUnavailable: true }));
    return;
  }
  const afterSnapshot = after.value;
  emit((s) => applyQueueSnapshot(s, afterSnapshot));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
