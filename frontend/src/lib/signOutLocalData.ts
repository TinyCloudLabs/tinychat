import { clearPersistedSession } from "@tinyboilerplate/client";

import { clearAllHeldAnswers, clearHeldAnswers } from "../feed/answerOutbox";
import { clearAllPostDrafts, clearPostDrafts } from "../feed/postAnswers";
import { clearAccountSignOutStorage } from "./accountSignOutStorage";
import { clearHeldResultsForSignOut } from "./voiceNotes/heldResults";
import type { IdbEnv } from "./voiceNotes/web/idb";

/**
 * What a sign-out removes from this device.
 * - "everything": the owner signed out. The account's credentials, caches and unsent work all go.
 * - "credentials": the session expired or the backend refused it. Credentials and caches go; the account's unsent
 *   work stays for its next sign-in. Each kept store is named by the account (space or DID) when it is written and
 *   read only under the signed-in account's own space or DID: held answers and post drafts by space, held transcript
 *   results and the `exo.*` job records by DID.
 */
export type SignOutScope = "everything" | "credentials";

export interface SignedOutAccount {
  /** The account's space; null when a restart finishes a sign-out with no client left to name it. */
  space: string | null;
  did: string | null;
  address: string | null;
}

/** The account's local storage at sign-out: its persisted session and caches, and, for "everything", its unsent work. */
export function clearSignedOutAccountStorage(scope: SignOutScope, account: SignedOutAccount): void {
  if (scope === "everything") {
    // The page-close outbox and post drafts hold the owner's words in this device's storage; both go with the account.
    // A sign-out that finds no client and no space (a restart with a sign-out still pending) clears the answers device-wide.
    if (account.space) { clearHeldAnswers(account.space); clearPostDrafts(account.space); } else { clearAllHeldAnswers(); clearAllPostDrafts(); }
  }
  if (account.address) clearPersistedSession(account.address);
  if (account.did && account.address) {
    clearAccountSignOutStorage(account.did, account.address, undefined, { keepUnsentWork: scope === "credentials" });
  }
}

/** Completed transcripts held on this device until saved to the space: removed only when the owner signs out. */
export async function clearSignedOutHeldResults(scope: SignOutScope, did: string | null, env?: IdbEnv): Promise<void> {
  if (scope === "everything" && did) await clearHeldResultsForSignOut(did, env);
}
