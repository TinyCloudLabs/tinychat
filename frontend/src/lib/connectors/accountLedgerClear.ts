/**
 * Account deletion erases the deleted-meeting record (`webhooks/purged/<source>/<address>`) for every
 * source that keeps one. It runs while the owner's session still exists: the routes are authenticated and
 * OpenKey's deletion page, which ends the session, comes after it.
 *
 * Clearing the record lifts the suppression it provides, so whatever could still deliver or import for this
 * owner is stopped first (a "fence"), and the record is cleared only once the fence is confirmed:
 *  - `DELETE /config` writes the disabled marker (the public receiver answers 401 from then on), revokes the
 *    routing token, drops the queue and stops a running drain (`connector-webhooks.ts`, the `/config` DELETE).
 *  - `DELETE /api/connectors/fireflies/delegation` removes the grant the server-side Fireflies importer
 *    writes with. A clear of the Fireflies record also resets that importer (`onLedgerCleared` in `index.ts`).
 *  - `DELETE /api/delegations` removes the connector grant the backend writes to the owner's space with, and
 *    clears the owner's exo state; `DELETE /api/exo/v1/grant` removes the exo sync grant.
 * The sign-in teardown (`DELETE /credentials/:source`) is not a fence: that route is not mounted.
 *
 * This is not a disconnect step. `connectorLifecycle` never clears a ledger on purpose (reconnecting must
 * not re-open what the owner deleted); here the whole account is going, so there is nothing left to guard.
 */

import { GRANOLA_LEDGER_SOURCE } from "./granolaCsvStrings";
import type { ConnectorWebhooksClient, ConnectorWebhooksResult } from "./webhooksApi";
import type { WebhookFailure } from "./connectorLifecycle";

/** Every source the backend keeps a deleted-meeting record for (`CONNECTOR_REGISTRY` plus `LEDGER_ONLY_SOURCES`). */
export const PURGE_LEDGER_SOURCES: readonly string[] = ["fireflies", GRANOLA_LEDGER_SOURCE];

export type PurgeLedgerClear =
  | { status: "done" }
  /** `fence`: delivery or import could not be stopped, so no record was cleared. `clear`: a record may remain. */
  | { status: "failed"; step: "fence" | "clear"; failure: WebhookFailure };

type LedgerWebhooks = Pick<ConnectorWebhooksClient, "disable" | "clearPurgeLedger"> &
  Partial<Pick<ConnectorWebhooksClient, "removeFirefliesImportGrant" | "removeBackendDelegation" | "removeExoGrant">>;

function failureOf(result: ConnectorWebhooksResult<unknown>): WebhookFailure | undefined {
  // `feature-dark` (the router is not mounted) holds nothing to stop or clear, as in the credential teardown.
  return result.status === "ok" || result.status === "feature-dark" ? undefined : result;
}

/**
 * Fences delivery and import, then clears each source's record through `DELETE /purged`. If either fence step
 * fails nothing is cleared. A failure on one source does not stop the others; the first failure is returned.
 */
export async function clearPurgeLedgersForAccountDeletion(
  webhooks: LedgerWebhooks,
  sources: readonly string[] = PURGE_LEDGER_SOURCES,
): Promise<PurgeLedgerClear> {
  // In this order, each attempted even if an earlier one failed, so one retry has less left to do.
  const fenced = [
    failureOf(await webhooks.disable()),
    webhooks.removeFirefliesImportGrant === undefined ? undefined : failureOf(await webhooks.removeFirefliesImportGrant()),
    webhooks.removeBackendDelegation === undefined ? undefined : failureOf(await webhooks.removeBackendDelegation()),
    webhooks.removeExoGrant === undefined ? undefined : failureOf(await webhooks.removeExoGrant()),
  ];
  const fenceFailure = fenced.find((failure) => failure !== undefined);
  if (fenceFailure !== undefined) return { status: "failed", step: "fence", failure: fenceFailure };

  let failure: WebhookFailure | undefined;
  for (const source of sources) {
    const failed = failureOf(await webhooks.clearPurgeLedger(source));
    failure ??= failed;
  }
  return failure === undefined ? { status: "done" } : { status: "failed", step: "clear", failure };
}
