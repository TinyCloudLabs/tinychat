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

/**
 * What the owner is asked to do at Google. Neutral on purpose: the exact name on Google's consent screen is set
 * in the Google Cloud console, not in this repository. Replace this one constant with the verified name.
 */
export const GOOGLE_REMOVE_ACCESS_PHRASE = "remove our app's access in your Google account";

/** Where an owner manages the apps that have access to their Google account. */
export const GOOGLE_CONNECTIONS_URL = "https://myaccount.google.com/connections";

/** The text of the link to `GOOGLE_CONNECTIONS_URL`, shown after either Calendar message. */
export const GOOGLE_CONNECTIONS_LINK_TEXT = "Open your Google account";

/** Shown, after the reason line, when Calendar autojoin could not be confirmed stopped or its sign-in removed. */
export const CALENDAR_NOT_STOPPED_MESSAGE =
  `We couldn't confirm that Calendar autojoin stopped or that your Google sign-in was removed from our server. Try again, or continue and ${GOOGLE_REMOVE_ACCESS_PHRASE}.`;

/** Shown when our server deleted the Google sign-in but Google did not confirm the revoke. */
export const GOOGLE_REVOKE_UNCONFIRMED_MESSAGE =
  `Calendar autojoin stopped and your Google sign-in was removed from our server, but Google didn't confirm it revoked access. To be sure, ${GOOGLE_REMOVE_ACCESS_PHRASE}.`;

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
