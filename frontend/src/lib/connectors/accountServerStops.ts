/**
 * Account deletion stops what our server could still do for the owner, while the owner's session still works
 * (the routes are authenticated):
 *  - `DELETE /config` writes the disabled marker (the public receiver answers 401 from then on), revokes the
 *    routing token, drops the queue and stops a running drain (`connector-webhooks.ts`, the `/config` DELETE).
 *  - `DELETE /api/connectors/fireflies/delegation` removes the grant the server-side Fireflies importer
 *    writes with.
 *  - `DELETE /api/delegations` removes the connector grant the backend writes to the owner's space with, and
 *    clears the owner's exo state; `DELETE /api/exo/v1/grant` removes the exo sync grant.
 * The sign-in teardown (`DELETE /credentials/:source`) is not one of these: that route is not mounted.
 *
 * Nothing here erases the record of deleted meetings (`webhooks/purged/<source>/<address>`). That record is
 * what keeps a deleted meeting from being imported again while a connector stays connected, and the account's
 * space outlives this flow, so it stays.
 */

import type { ConnectorWebhooksClient, ConnectorWebhooksResult } from "./webhooksApi";
import type { WebhookFailure } from "./connectorLifecycle";

export type ServerStops =
  | { status: "done" }
  | { status: "failed"; failure: WebhookFailure };

type StopWebhooks = Pick<ConnectorWebhooksClient, "disable"> &
  Partial<Pick<ConnectorWebhooksClient, "removeFirefliesImportGrant" | "removeBackendDelegation" | "removeExoGrant">>;

function failureOf(result: ConnectorWebhooksResult<unknown>): WebhookFailure | undefined {
  // `feature-dark` (the router is not mounted) holds nothing to stop, as in the credential teardown.
  return result.status === "ok" || result.status === "feature-dark" ? undefined : result;
}

/**
 * Runs every stop, in this order, each attempted even if an earlier one failed so a retry has less left to do.
 * Returns the first failure.
 */
export async function stopServerAccessForAccountDeletion(webhooks: StopWebhooks): Promise<ServerStops> {
  const results = [
    failureOf(await webhooks.disable()),
    webhooks.removeFirefliesImportGrant === undefined ? undefined : failureOf(await webhooks.removeFirefliesImportGrant()),
    webhooks.removeBackendDelegation === undefined ? undefined : failureOf(await webhooks.removeBackendDelegation()),
    webhooks.removeExoGrant === undefined ? undefined : failureOf(await webhooks.removeExoGrant()),
  ];
  const failure = results.find((one) => one !== undefined);
  return failure === undefined ? { status: "done" } : { status: "failed", failure };
}
