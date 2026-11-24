// The one place the network-wide decrypt is requested (TC-4225). Loaded only when the owner chooses "Move earlier
// history", so nothing of it is in the entry chunk.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet } from "@tinyboilerplate/client";
import { earlierHistoryPermissions } from "./earlierHistory";
import { EARLIER_HISTORY_STRINGS } from "./earlierHistoryStrings";
import { ownerPermissionRequester } from "./historyAuthorization";

/**
 * The owner's request to move earlier history: asks for decrypt on the whole network (the one place it is asked) and
 * resolves with whether it was approved. A decline touches nothing else; the chat's own authorization is separate.
 */
export async function requestEarlierHistoryAccess(tcw: TinyCloudWeb, connect = connectWallet): Promise<boolean> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const permissions = earlierHistoryPermissions(session.address, session.chainId ?? 1)
    .map(entry => ({ ...entry, description: EARLIER_HISTORY_STRINGS.approval }));
  if (tcw.hasPermissions(permissions)) return true;
  if (!(await ownerPermissionRequester(tcw, session, connect)(permissions))) return false;
  if (!tcw.hasPermissions(permissions)) throw new Error("history_authority_missing");
  return true;
}
