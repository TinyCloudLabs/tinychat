// The grant One gives a framed app's own session key: one per space, an hour long, and never re-delegable. In the
// phone app it comes from that app's step-up (TC-3568 S1b); the node refuses a child of it
// (`terminal-parent-cannot-redelegate`).
import { serializeDelegation, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { SpaceNotHostedError, type EmbedHostDeps } from "./embedHost";

export const FRAME_GRANT_LIFETIME_MS = 60 * 60 * 1000;

/** True when the node skipped the delegation's space: it answered 200 but does not host it (requireActivation). */
function skippedByNode(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { success?: unknown; skipped?: unknown } | undefined) : undefined;
  return cause?.success === true && Array.isArray(cause.skipped) && cause.skipped.length > 0;
}

/** EmbedHost's `delegate`: one space's grant to the frame's key, from One's session. */
export function frameGrantDelegate(tcw: Pick<TinyCloudWeb, "delegateTo">): EmbedHostDeps["delegate"] {
  return async (audience, entries) => {
    let made: Awaited<ReturnType<TinyCloudWeb["delegateTo"]>>;
    try {
      made = await tcw.delegateTo(audience, entries, { expiry: FRAME_GRANT_LIFETIME_MS, disableSubDelegation: true, requireActivation: true });
    } catch (error) {
      if (skippedByNode(error) && entries[0]?.space) throw new SpaceNotHostedError(entries[0].space);
      throw error;
    }
    const { delegation, prompted } = made;
    return {
      spaceId: delegation.spaceId,
      cid: delegation.cid,
      delegation: serializeDelegation(delegation),
      expiresAt: new Date(delegation.expiry).getTime(),
      prompted,
    };
  };
}
