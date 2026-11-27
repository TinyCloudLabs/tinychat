// The meeting code of a Google Meet import, for calendar linking: the import keeps its space (`spaces/{id}`), and
// Google's spaces.get gives that space's code. It is asked with the Google Meet connector's own token, and only
// while that connector is connected: calendar linking's consent covers the calendar, not Meet.
import { normalizeMeetCode } from "@tinyboilerplate/core";

import { getConnectorKey, isSecretsUnlocked, type SecretsErr } from "@/lib/connectors/connectorSecrets";
import { getConnection } from "@/lib/connectors/connectorStore";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import { mintGoogleAccessToken, type CalendarLinkDeps } from "@/lib/connectors/googleCalendarLink";
import { CONNECTORS } from "@/lib/connectors/registry";
import { scheduledSpace } from "@/lib/spaceQueue";

const MEET_CONNECTOR_ID = "google-meet";

/**
 * A space's code: the code; null when there is none to be had (the connector is not connected or has lost its
 * grant, or Google answers that this user cannot see the space); undefined when it could not be asked just now
 * (a locked vault, no session, the network).
 */
export type MeetCodeRead = (space: string) => Promise<string | null | undefined>;

export interface MeetCodes {
  /** A reader for one batch of notes: the connector's state is read once and one access token is minted. */
  reader(signal: AbortSignal): MeetCodeRead;
}

/** Google's answers are kept for the session: every instance of a series meets in the same space. */
export function createMeetCodes(deps: CalendarLinkDeps): MeetCodes {
  const answers = new Map<string, string | null>();

  /** The Meet API as the connector may use it: null when it is not connected, undefined when it cannot be reached now. */
  const open = async (signal: AbortSignal): Promise<GmeetClient | null | undefined> => {
    const descriptor = CONNECTORS.find((connector) => connector.id === MEET_CONNECTOR_ID);
    if (!descriptor || descriptor.status !== "available") return null;
    const connection = await getConnection(scheduledSpace(deps.tcw), descriptor.id);
    if (!connection.ok) return undefined;
    if (connection.data?.status !== "connected") return null;
    // A property read, never a prompt.
    if (!isSecretsUnlocked(deps.tcw)) return undefined;
    const secret = await getConnectorKey<SecretsErr>(deps.tcw, descriptor);
    if (!secret.ok || typeof secret.data !== "string" || secret.data.length === 0) return null;
    const stored = secret.data;
    let gone = false;
    const mint = async () => {
      const minted = await mintGoogleAccessToken({ backendUrl: deps.backendUrl, sessionStore: deps.sessionStore, stored, signal, fetchImpl: deps.fetchImpl });
      if (!minted.ok) gone = minted.reason === "invalid-grant";
      return minted.ok ? minted.token : null;
    };
    const accessToken = await mint();
    if (accessToken === null) return gone ? null : undefined;
    return new GmeetClient({ accessToken, refreshAccessToken: mint, fetchImpl: deps.fetchImpl, signal, maxRateLimitRetries: 0 });
  };

  return {
    reader(signal) {
      let client: Promise<GmeetClient | null | undefined> | undefined;
      return async (space) => {
        if (answers.has(space)) return answers.get(space);
        const meet = await (client ??= open(signal).catch(() => undefined));
        if (!meet) return meet;
        const read = await meet.getSpaceMeetingCode(space);
        if (!read.ok && read.error.kind !== "forbidden" && read.error.kind !== "not-found") return undefined;
        const code = read.ok ? normalizeMeetCode(read.data) : null;
        answers.set(space, code);
        return code;
      };
    },
  };
}
