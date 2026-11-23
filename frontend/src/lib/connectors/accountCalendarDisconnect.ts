/**
 * Account deletion stops Calendar autojoin and deletes the Google sign-in our server holds
 * (`POST /api/connectors/google/autojoin/disconnect` with `{}`, the body the connector dialog sends). It runs
 * first, ahead of the recordings: while autojoin is on it can still send a recorder into a meeting and create
 * a recording the recordings step has already passed. It needs the owner's session, which OpenKey's page ends.
 *
 * The browser's own copy of the Google token is not touched here. Our server asks Google to revoke the grant
 * and reports whether Google confirmed it.
 */

import type { WebhookFailure } from "./connectorLifecycle";
import type { ConnectorWebhooksClient } from "./webhooksApi";

/** Shown when our server deleted the Google sign-in but Google did not confirm the revoke. */
export const GOOGLE_REVOKE_UNCONFIRMED_MESSAGE =
  "Calendar autojoin was stopped and your Google sign-in was removed from our server, but Google didn't confirm it revoked access. To be sure, remove TinyChat under connected apps in your Google account.";

export type CalendarDisconnect =
  | { status: "done" }
  /** The local delete happened; Google's confirmation is missing and a retry cannot add it. */
  | { status: "notice" }
  | { status: "failed"; failure: WebhookFailure };

export async function disconnectCalendarForAccountDeletion(
  webhooks: Pick<ConnectorWebhooksClient, "disconnectCalendarAutojoin">,
): Promise<CalendarDisconnect> {
  if (webhooks.disconnectCalendarAutojoin === undefined) return { status: "done" };
  const result = await webhooks.disconnectCalendarAutojoin();
  // `feature-dark`: autojoin is not mounted here, so there is nothing to stop.
  if (result.status === "feature-dark") return { status: "done" };
  if (result.status !== "ok") return { status: "failed", failure: result };
  return result.value.upstreamRevoked === "failed" ? { status: "notice" } : { status: "done" };
}
