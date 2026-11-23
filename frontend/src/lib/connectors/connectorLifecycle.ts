/**
 * Connector teardown — the real disconnect, purge and reconnect lifecycle.
 *
 * The v1 disconnect dialog deleted the API key (and optionally the meetings)
 * and stopped there. With Option-C background notifications that is the exact
 * shape the handoff calls out as unsafe: the key is gone, but the delivery
 * address is still live, the backend queue still fills, and nothing records
 * that the meetings were deleted. This module is the ordered teardown that
 * closes all three, and it is a plain state machine rather than dialog code so
 * every ORDER claim below is pinned by test instead of by comment.
 *
 * THE THREE FLOWS
 *
 *   "disable notifications only"  is NOT here — it is `DELETE /config` alone
 *     (`backgroundSyncState.disableBackgroundSync`), and it deliberately keeps
 *     the API key and every meeting.
 *
 *   keep-data     disable delivery → delete the key → mark disconnected.
 *   delete-data   collect ids → TOMBSTONE → disable delivery → delete the key
 *                 → purge locally.
 *
 * WHY THE TOMBSTONE COMES FIRST. The ledger is what stops a signed delivery —
 * one already in flight, or one replayed later — from re-adding a meeting the
 * user just deleted. Writing it after the local delete leaves a window in which
 * the meeting is gone locally and unprotected remotely, which §6.2 names as the
 * precise failure the ledger exists to prevent. It is also why a failed
 * tombstone stops the whole run before anything is deleted at all.
 *
 * WHY DISABLE COMES BEFORE THE KEY. Once the key is gone the browser cannot
 * collect anything, so a still-live webhook only grows a queue nobody can
 * drain. Turning delivery off first means every intermediate state is one the
 * product can explain.
 *
 * PARTIAL FAILURE IS NEVER A DISCONNECT. `runDisconnect` resolves a
 * {@link DisconnectProgress}; only `done === true` means the connector is
 * actually torn down. Anything else carries a `failure` and a
 * {@link disconnectRetry} action that RESUMES — the completed steps, and in
 * particular the ids collected before any deletion, are carried forward so a
 * retry cannot re-read an already-emptied space and tombstone nothing.
 *
 * WHAT THIS MODULE NEVER DOES. It never clears the purge ledger. Reconnecting
 * a connector must not silently re-open the door to everything the user
 * deleted; clearing it is the separate, explicitly-confirmed "allow historical
 * re-sync" action (`DELETE /purged`) that lives on the background-notifications
 * surface. `DisconnectWebhooks` does not even name that method.
 *
 * Storage calls are sequential throughout — TinyCloud drops concurrent
 * responses on one space.
 */

import {
  CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE,
  type ConnectorCredentialTeardown,
  type ConnectorPurgeOverflow,
  type ConnectorPurgeRequest,
  type ConnectorWebhookDisabled,
  type ConnectorWebhooksResult,
} from "./webhooksApi";
import type { StoreResult, UpdateSyncStateInput } from "./connectorStore";
import type { ConnectorConnection, ConnectorId } from "./types";
import { beginFirefliesDisconnect } from "./firefliesSync";
import { stopGmeetNotesSync } from "./gmeetSync";

// ── The plans ────────────────────────────────────────────────────────

export type DisconnectMode = "keep-data" | "delete-data";

export type DisconnectStep =
  /** Read the ids that are about to be deleted, while they still exist. */
  | "collect-ids"
  /** `POST /purged` — the tombstone, written before anything is deleted. */
  | "record-purge"
  /** `DELETE /config` — delivery stops. */
  | "disable-webhooks"
  /**
   * `DELETE /api/connectors/credentials/:source` — the stored provider sign-in,
   * its upstream revoke, held content and queue. Fireflies only, and only when
   * the webhooks lane carries it (see {@link planFor}).
   */
  | "teardown-server-credential"
  /** Remove the provider API key from encrypted secrets. */
  | "delete-key"
  /** Delete the local rows and transcript bodies. */
  | "purge-local"
  /** Clear Fireflies-only bounded-listing metadata before a kept row reconnects. */
  | "clear-sync-continuation"
  /** Flip the connector row to `disconnected`, keeping the data. */
  | "mark-disconnected";

export const DISCONNECT_PLANS: Record<DisconnectMode, readonly DisconnectStep[]> = {
  "keep-data": ["disable-webhooks", "delete-key", "clear-sync-continuation", "mark-disconnected"],
  "delete-data": [
    "collect-ids",
    "record-purge",
    "disable-webhooks",
    "delete-key",
    "purge-local",
  ],
};

/**
 * The plan a run actually follows. Fireflies, whose server-ingest path can hold
 * the owner's sign-in, also runs the server teardown — BEFORE `disable-webhooks`:
 * the route closes ingress and writes the purge ledger first, so by the time
 * delivery is switched off there is nothing a late delivery could re-add, and a
 * failure leaves the API key in place with the retry still possible. For
 * delete-data it sits after `record-purge`. An owner with no stored sign-in
 * still gets the full server `DELETE`, and the teardown clears the purge
 * ledger at its end.
 * A lane without `teardownCredential` (Google, which has no server sign-in to
 * remove here, and any caller that does not wire it) has no such step.
 */
export function planFor(deps: Pick<DisconnectDeps, "connectorId" | "mode" | "webhooks">): readonly DisconnectStep[] {
  // Granola has no push lane. `DELETE /config` is owner-wide (it revokes the one webhook token and
  // clears every source's queue), so a Granola disconnect must not run it: it would also switch off
  // Fireflies instant updates for the same owner.
  const plan =
    deps.connectorId === "granola"
      ? DISCONNECT_PLANS[deps.mode].filter((step) => step !== "disable-webhooks")
      : DISCONNECT_PLANS[deps.mode];
  if (deps.connectorId !== "fireflies" || deps.webhooks.teardownCredential === undefined) {
    return plan;
  }
  const at = plan.indexOf("disable-webhooks");
  return [...plan.slice(0, at), "teardown-server-credential", ...plan.slice(at)];
}

export interface DisconnectFailure {
  step: DisconnectStep;
  /** Human-readable, and free of meeting ids — it is rendered. */
  message: string;
  /** True when repeating the SAME run is the correct next move. */
  retryable: boolean;
}

export interface DisconnectProgress {
  mode: DisconnectMode;
  /** Steps that finished, in the order they finished. */
  completed: DisconnectStep[];
  running: DisconnectStep | null;
  failure: DisconnectFailure | null;
  /** True ONLY when every step of the plan finished. The success signal. */
  done: boolean;
  /**
   * The ids `collect-ids` saw. Carried across a retry so a resumed run
   * tombstones what existed BEFORE the deletion, never an emptied space.
   */
  ids: string[] | null;
  /**
   * The ids of the import permissions the server held when the run began; `[]` once withdrawn.
   * Carried across a retry because the server has nothing left to list after its first step.
   */
  grantCids?: string[];
  /** A message the owner must still read after the run completed, e.g. an unconfirmed revoke. */
  notice?: string;
}

export function initialDisconnectProgress(mode: DisconnectMode): DisconnectProgress {
  return {
    mode,
    completed: [],
    running: null,
    failure: null,
    done: false,
    ids: null,
  };
}

/** The one action a partial teardown offers. `null` once the run completed. */
export interface DisconnectRetry {
  label: string;
  /** The step the retry picks up at — everything before it already landed. */
  resumesFrom: DisconnectStep;
}

export function disconnectRetry(progress: DisconnectProgress): DisconnectRetry | null {
  if (progress.done || progress.failure === null) return null;
  return {
    label: progress.failure.retryable
      ? "Try finishing the disconnect again"
      : "Review and try again",
    resumesFrom: progress.failure.step,
  };
}

/**
 * What the surface says while, and after, a teardown runs. Never claims a
 * disconnect that did not happen.
 */
export function disconnectStatusMessage(progress: DisconnectProgress): string | null {
  if (progress.done) {
    const base =
      progress.mode === "delete-data"
        ? "Disconnected. Your meetings have been deleted and background notifications are off."
        : "Disconnected. Your meetings are still in your space and background notifications are off.";
    return progress.notice ? `${base} ${progress.notice}` : base;
  }
  if (progress.failure) {
    return `${progress.failure.message} Nothing beyond this point was changed.`;
  }
  if (progress.running) return RUNNING_LABEL[progress.running];
  return null;
}

const RUNNING_LABEL: Record<DisconnectStep, string> = {
  "collect-ids": "Listing the meetings to delete…",
  "record-purge": "Recording that these meetings were deleted…",
  "disable-webhooks": "Turning off background notifications…",
  "teardown-server-credential": "Removing the saved Fireflies sign-in from our server…",
  "delete-key": "Removing your API key…",
  "purge-local": "Deleting meetings from your space…",
  "clear-sync-continuation": "Clearing the Fireflies listing continuation…",
  "mark-disconnected": "Updating the connector…",
};

// ── Dependencies ─────────────────────────────────────────────────────

/**
 * The webhook calls a teardown makes — and only those. `clearPurgeLedger` is
 * absent BY DESIGN: no teardown or reconnect may clear a purge ledger.
 */
export interface DisconnectWebhooks {
  disable(): Promise<ConnectorWebhooksResult<ConnectorWebhookDisabled>>;
  recordPurge(
    request: ConnectorPurgeRequest,
  ): Promise<ConnectorWebhooksResult<ConnectorPurgeOverflow | null>>;
  /**
   * Fireflies only. Resolves the server teardown; `ok` with `upstreamRevoked:
   * false` is the one outcome the owner must be told about.
   */
  teardownCredential?(
    source: string,
  ): Promise<ConnectorWebhooksResult<ConnectorCredentialTeardown | null>>;
}

export interface DisconnectSecrets {
  isUnlocked(): boolean;
  unlock(): Promise<{ ok: true } | { ok: false; error?: { message?: string } }>;
  deleteKey(): Promise<{ ok: true } | { ok: false; error?: { message?: string } }>;
}

export interface DisconnectStore {
  listKnownSourceIds(): Promise<StoreResult<string[]>>;
  purgeConnector(): Promise<StoreResult<void>>;
  clearFirefliesAttempt(): Promise<StoreResult<void>>;
  getConnection(): Promise<StoreResult<ConnectorConnection | null>>;
  countMeetings(): Promise<StoreResult<number>>;
  updateSyncState(input: UpdateSyncStateInput): Promise<StoreResult<void>>;
}

/** What a teardown needs to withdraw the Fireflies import permissions: list them, then revoke each at the node. */
export interface DisconnectImportGrants {
  listGrantCids(): Promise<ConnectorWebhooksResult<string[]>>;
  /** True once the permission is revoked at the node. */
  revoke(cid: string): Promise<boolean>;
}

export interface DisconnectDeps {
  connectorId: ConnectorId;
  /** The SQL/source name, sent verbatim to `POST /purged`. */
  source: string;
  mode: DisconnectMode;
  webhooks: DisconnectWebhooks;
  secrets: DisconnectSecrets;
  store: DisconnectStore;
  /**
   * A purge scoped to a SUBSET of the user's meetings. When set,
   * {@link DisconnectDeps.purgedThrough} is REQUIRED — see the runner.
   */
  scopedIds?: readonly string[];
  /**
   * The explicit provider watermark. Omitted for "forget everything up to
   * now", where the route's `purgedThrough=now` default is what is wanted.
   */
  purgedThrough?: string;
  /**
   * Whether the companion router is ESTABLISHED to be unmounted — the verdict
   * of the mount-time `GET /config` probe the card already runs, carried here
   * as state. Default `false`: unknown is not dark.
   *
   * A 404 on a single call is NOT evidence of this. Every path inside the
   * router exists, but a method/path drift, a reverse proxy, or a bundle that
   * outlived a backend route rename answers 404 from a MOUNTED router just the
   * same. Forgiving that 404 made a delete-data teardown skip the purge
   * tombstone AND the `DELETE /config`, delete the key and the local rows, and
   * report success — the meeting the user deleted then comes back off the
   * still-live queue on the next visit, which is precisely the failure
   * `docs/connector-webhooks-purge-tombstone.md` §6.2 exists to prevent. So a
   * 404 is forgiven only when darkness was established BEFORE the teardown, and
   * is otherwise a hard failure with a retry.
   */
  featureDark?: boolean;
  /**
   * Fireflies only, when the server import is wired. The permissions the server holds for this
   * owner are listed before the first server step and withdrawn at the node after `DELETE /config`.
   */
  importGrants?: DisconnectImportGrants;
}

export type DisconnectEmit = (
  updater: (prev: DisconnectProgress) => DisconnectProgress,
) => void;

// ── The runner ───────────────────────────────────────────────────────

/**
 * Run (or resume) a teardown.
 *
 * Pass `from` to resume: every step already in `from.completed` is skipped and
 * `from.ids` is reused, so a retry after a failed delete cannot re-collect from
 * a space that is already half empty.
 *
 * Resolves the final progress. `done === true` is the ONLY success signal;
 * every other outcome carries a `failure` and a {@link disconnectRetry}.
 */
export async function runDisconnect(
  deps: DisconnectDeps,
  emit: DisconnectEmit,
  from?: DisconnectProgress,
): Promise<DisconnectProgress> {
  // A deferred Notes reconcile writes rows and its final state row after its caller
  // returned; it must be stopped before the teardown or it would undo the disconnect.
  if (deps.connectorId === "google-meet") await stopGmeetNotesSync();
  const release = deps.connectorId === "fireflies"
    ? await beginFirefliesDisconnect()
    : () => undefined;
  try {
    return await runDisconnectSteps(deps, emit, from);
  } finally {
    release();
  }
}

async function runDisconnectSteps(
  deps: DisconnectDeps,
  emit: DisconnectEmit,
  from?: DisconnectProgress,
): Promise<DisconnectProgress> {
  const plan = planFor(deps);
  let progress: DisconnectProgress = from
    ? { ...from, running: null, failure: null, done: false, completed: [...from.completed] }
    : initialDisconnectProgress(deps.mode);
  const push = (next: DisconnectProgress) => {
    progress = next;
    emit(() => next);
  };
  push(progress);

  // Fail closed BEFORE any I/O. A scoped purge that omits the watermark would
  // take the route's `now` default, silently suppressing every meeting older
  // than the request — including the ones the user chose to keep
  // (docs/connector-webhooks-purge-tombstone.md §3).
  if (deps.scopedIds !== undefined && deps.purgedThrough === undefined) {
    push({
      ...progress,
      running: null,
      failure: {
        step: "record-purge",
        message:
          "A partial delete needs the timestamp of the newest meeting it covers. Without it we would mark everything older as deleted too.",
        retryable: false,
      },
    });
    return progress;
  }

  for (const step of plan) {
    if (progress.completed.includes(step)) continue;
    push({ ...progress, running: step });
    // The first step that can make the server drop its stored permissions must find their ids
    // already read: afterwards the server has nothing left to list.
    if (deps.importGrants !== undefined && progress.grantCids === undefined && SERVER_GRANT_STEPS.includes(step)) {
      const collected = await collectImportGrantCids(deps.importGrants, step);
      if (collected.failure) {
        push({ ...progress, running: null, failure: collected.failure });
        return progress;
      }
      push({ ...progress, grantCids: collected.grantCids });
    }
    const outcome = await runStep(step, deps, progress);
    if (outcome.failure) {
      push({ ...progress, running: null, failure: outcome.failure });
      return progress;
    }
    // `DELETE /config` is the step after which the server no longer holds the permissions, whatever
    // the mode, so it is where they are withdrawn at the node as well.
    let notice = outcome.notice;
    let grantCids = progress.grantCids;
    if (step === "disable-webhooks" && deps.importGrants !== undefined && grantCids !== undefined && grantCids.length > 0) {
      const stillValid = await revokeImportGrants(deps.importGrants, grantCids);
      if (stillValid) notice = [notice ?? progress.notice, IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE].filter(Boolean).join(" ");
      grantCids = [];
    }
    push({
      ...progress,
      running: null,
      completed: [...progress.completed, step],
      ...(outcome.ids === undefined ? {} : { ids: outcome.ids }),
      ...(grantCids === undefined ? {} : { grantCids }),
      ...(notice === undefined ? {} : { notice }),
    });
  }

  push({ ...progress, running: null, failure: null, done: true });
  return progress;
}

interface StepOutcome {
  failure?: DisconnectFailure;
  ids?: string[];
  notice?: string;
}

async function runStep(
  step: DisconnectStep,
  deps: DisconnectDeps,
  progress: DisconnectProgress,
): Promise<StepOutcome> {
  switch (step) {
    case "collect-ids":
      return collectIds(deps);
    case "record-purge":
      return recordPurge(deps, progress);
    case "teardown-server-credential":
      return teardownServerCredential(deps);
    case "disable-webhooks":
      return disableWebhooks(deps);
    case "delete-key":
      return deleteKey(deps);
    case "purge-local":
      return purgeLocal(deps);
    case "clear-sync-continuation":
      return clearSyncContinuation(deps);
    case "mark-disconnected":
      return markDisconnected(deps);
}
  }

async function collectIds(deps: DisconnectDeps): Promise<StepOutcome> {
  // A scoped purge names its own ids, so the whole-space read is skipped.
  if (deps.scopedIds !== undefined) return { ids: [...deps.scopedIds] };
  const res = await deps.store.listKnownSourceIds();
  if (!res.ok) {
    return {
      failure: {
        step: "collect-ids",
        message: `Couldn't list the meetings to delete: ${res.error.message}`,
        retryable: true,
      },
    };
  }
  return { ids: res.data };
}

async function recordPurge(
  deps: DisconnectDeps,
  progress: DisconnectProgress,
): Promise<StepOutcome> {
  const request: ConnectorPurgeRequest = {
    source: deps.source,
    // An empty list is still a real purge: the WATERMARK is what suppresses an
    // in-flight delivery, and `recentIds` is forensics.
    ids: progress.ids ?? [],
    ...(deps.purgedThrough === undefined ? {} : { purgedThrough: deps.purgedThrough }),
  };
  const result = await deps.webhooks.recordPurge(request);
  if (result.status === "ok") return {};
  // A router that is not mounted has no ledger to write and no queue that could
  // resurrect anything — nothing to record, so nothing is lost. Only the
  // mount-time probe may say that; see `DisconnectDeps.featureDark`.
  if (result.status === "feature-dark" && deps.featureDark === true) return {};
  return {
    failure: {
      step: "record-purge",
      message: `${webhookFailureMessage(result)} ${deps.importGrants === undefined ? "Nothing has been deleted" : "No meetings were deleted, though our server may already have dropped its permission to import more"} — we record the deletion first so a late notification can't bring these meetings back.`,
      retryable: isRetryable(result),
    },
  };
}

async function disableWebhooks(deps: DisconnectDeps): Promise<StepOutcome> {
  const result = await deps.webhooks.disable();
  if (result.status === "ok") return {};
  if (result.status === "feature-dark" && deps.featureDark === true) return {};
  return {
    failure: {
      step: "disable-webhooks",
      message: `${webhookFailureMessage(result)} Your API key has not been removed yet.`,
      retryable: isRetryable(result),
    },
  };
}

/** Steps that can make the server drop the stored import permissions; the first one to run reads their ids. */
const SERVER_GRANT_STEPS: readonly DisconnectStep[] = ["record-purge", "teardown-server-credential", "disable-webhooks"];

export const IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE =
  "Our server no longer holds the permission to import your Fireflies meetings, but we couldn't confirm it was withdrawn everywhere. It ends on its own within 7 days.";

export async function collectImportGrantCids(
  importGrants: DisconnectImportGrants,
  step: DisconnectStep,
): Promise<{ failure: DisconnectFailure } | { failure?: undefined; grantCids: string[] }> {
  const listed = await importGrants.listGrantCids();
  if (listed.status === "ok") return { grantCids: listed.value };
  // The server has the import off, so it holds no permission to list.
  if (listed.status === "feature-dark") return { grantCids: [] };
  return {
    failure: {
      step,
      message: `${webhookFailureMessage(listed)} We couldn't check which Fireflies import permissions our server holds. Nothing has been changed.`,
      retryable: isRetryable(listed),
    },
  };
}

/** True when at least one permission could not be confirmed withdrawn. Each gets one more try. */
export async function revokeImportGrants(importGrants: DisconnectImportGrants, cids: readonly string[]): Promise<boolean> {
  let unconfirmed = false;
  for (const cid of cids) {
    let revoked = false;
    for (let attempt = 0; attempt < 2 && !revoked; attempt += 1) {
      try {
        revoked = await importGrants.revoke(cid);
      } catch {
        revoked = false;
      }
    }
    if (!revoked) unconfirmed = true;
  }
  return unconfirmed;
}

export type ServerCredentialTeardown =
  | { status: "done"; notice?: string }
  | { status: "failed"; failure: WebhookFailure };

/**
 * A 404 is forgiven here, unlike `record-purge`, only when it carries the backend's own
 * not-available marker (the credentials router is mounted only behind its flag, and answers
 * 404 to an owner who is not enrolled): that is "nothing server-held to
 * remove". An unmarked 404 (a proxy, a wrong path) is a retryable failure. The steps that matter for every connector (tombstone,
 * `DELETE /config`, key, rows) are separate and strict. A failed read of whether
 * a sign-in is stored is a failure, never a skip: a cohort owner's sign-in must
 * not be silently kept. Shared with account deletion, which must not carry a
 * second implementation.
 */
export async function runServerCredentialTeardown(
  webhooks: Pick<DisconnectWebhooks, "teardownCredential">,
  source: string,
): Promise<ServerCredentialTeardown> {
  if (webhooks.teardownCredential === undefined) return { status: "done" };
  const result = await webhooks.teardownCredential(source);
  if (result.status === "ok") {
    // `null`: no sign-in was stored for this owner, so there is no revoke to confirm.
    if (result.value === null || result.value.upstreamRevoked) return { status: "done" };
    return { status: "done", notice: CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE };
  }
  if (result.status === "feature-dark") return { status: "done" };
  return { status: "failed", failure: result };
}

async function teardownServerCredential(deps: DisconnectDeps): Promise<StepOutcome> {
  const outcome = await runServerCredentialTeardown(deps.webhooks, deps.source);
  if (outcome.status === "done") {
    return outcome.notice === undefined ? {} : { notice: outcome.notice };
  }
  return {
    failure: {
      step: "teardown-server-credential",
      message: `${webhookFailureMessage(outcome.failure)} Your API key has not been removed yet.`,
      retryable: isRetryable(outcome.failure),
    },
  };
}

async function deleteKey(deps: DisconnectDeps): Promise<StepOutcome> {
  if (!deps.secrets.isUnlocked()) {
    const unlock = await deps.secrets.unlock();
    if (!unlock.ok) {
      return {
        failure: {
          step: "delete-key",
          message: `Couldn't unlock your secrets: ${unlock.error?.message ?? "unlock was not completed"}.`,
          retryable: true,
        },
      };
    }
  }
  const del = await deps.secrets.deleteKey();
  if (!del.ok) {
    return {
      failure: {
        step: "delete-key",
        message: `Couldn't remove your API key: ${del.error?.message ?? "the secrets store refused the delete"}.`,
        retryable: true,
      },
    };
  }
  return {};
}

async function purgeLocal(deps: DisconnectDeps): Promise<StepOutcome> {
  const res = await deps.store.purgeConnector();
  if (!res.ok) {
    return {
      failure: {
        step: "purge-local",
        message: `Couldn't delete the meetings from your space: ${res.error.message}.`,
        retryable: true,
      },
    };
  }
  return {};
}

async function clearSyncContinuation(deps: DisconnectDeps): Promise<StepOutcome> {
  if (deps.connectorId !== "fireflies") return {};
  const result = await deps.store.clearFirefliesAttempt();
  if (result.ok) return {};
  return {
    failure: {
      step: "clear-sync-continuation",
      message: `Couldn't clear the Fireflies listing continuation: ${result.error.message}.`,
      retryable: true,
    },
  };
}
/**
 * Keep-data's last step. `lastSyncedAt` is preserved deliberately: the meetings
 * are still there, and blanking it would read as "never synced". The count is
 * re-read rather than carried, because it is the row the card renders.
 * Sequential — three calls on one space.
 */
async function markDisconnected(deps: DisconnectDeps): Promise<StepOutcome> {
  const existing = await deps.store.getConnection();
  if (!existing.ok) {
    return {
      failure: {
        step: "mark-disconnected",
        message: `Couldn't read the connector's state: ${existing.error.message}.`,
        retryable: true,
      },
    };
  }
  const count = await deps.store.countMeetings();
  if (!count.ok) {
    return {
      failure: {
        step: "mark-disconnected",
        message: `Couldn't count your meetings: ${count.error.message}.`,
        retryable: true,
      },
    };
  }
  const upd = await deps.store.updateSyncState({
    connectorId: deps.connectorId,
    status: "disconnected",
    lastSyncedAt: existing.data?.lastSyncedAt ?? null,
    lastSyncStatus: existing.data?.lastSyncStatus ?? null,
    lastSyncError: null,
    itemCount: count.data,
  });
  if (!upd.ok) {
    return {
      failure: {
        step: "mark-disconnected",
        message: `Couldn't update the connector: ${upd.error.message}.`,
        retryable: true,
      },
    };
  }
  return {};
}

// ── Failure translation ──────────────────────────────────────────────

export type WebhookFailure = Exclude<ConnectorWebhooksResult<never>, { status: "ok" }>;

function isRetryable(result: WebhookFailure): boolean {
  // `rejected` is a 4xx a retry cannot fix. Everything else — including a lost
  // session, which the user fixes by signing in again — is worth another go.
  return result.status !== "rejected";
}

export function webhookFailureMessage(result: WebhookFailure): string {
  switch (result.status) {
    case "unauthenticated":
      return "Your session expired before we could finish.";
    case "offline":
      return "Couldn't reach the server.";
    case "retryable":
      return `The server is temporarily unavailable (${result.httpStatus}).`;
    case "rejected":
      return `The server refused that request${result.code ? ` (${result.code})` : ""}.`;
    case "feature-dark":
      // Reached only when darkness was NOT established by the mount-time probe:
      // a 404 from a router we have every reason to believe is mounted.
      return "The server couldn't find the background-notifications service.";
  }
}
