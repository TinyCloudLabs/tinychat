// TC-3547: the `finish-setup=registry` link, and the Home card that navigates to it. The SDK publishes only from TinyCloud
// One and Home (an exact origin match) and signs nothing elsewhere, so the host asks every time and acts on the verdict.
import { ensureRegistryRecord, type RegistryPublishClient, type RegistryPublishOutcome } from "./adapter";
import { registryDismissedStore, type DismissedStore } from "./dismissed";
import { openRegistrySetupLink } from "./setupLink";

/** The SDK's `FINISH_SETUP_REGISTRY_INTENT` ("finish-setup=registry"), matched as a name and a fixed value. */
const INTENT_PARAM = "finish-setup";
const INTENT_VALUE = "registry";
/** The query the Home card navigates to: this module's own link, so the card runs the same path as a pasted link. */
export const FINISH_SETUP_INTENT_SEARCH = `?${INTENT_PARAM}=${INTENT_VALUE}`;

export type RegistryPublishEnv = {
  location: Pick<Location, "origin" | "pathname" | "search" | "hash">;
  history: Pick<History, "replaceState" | "state">;
};

export function hasFinishSetupRegistryIntent(search: string): boolean {
  return new URLSearchParams(search).get(INTENT_PARAM) === INTENT_VALUE;
}

/** The page's address without the intent, leaving every other parameter and the hash as they were. */
export function withoutFinishSetupIntent(location: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(location.search);
  params.delete(INTENT_PARAM);
  const query = params.toString();
  return location.pathname + (query ? `?${query}` : "") + location.hash;
}

/** "notice": the link was opened without the card (a pasted or shared link), so the SDK was not asked: show the notice. */
export type FinishSetupOutcome = RegistryPublishOutcome | "no-intent" | "notice";

/**
 * The router state the Home card navigates with: the owner just read the card's words. It lives in the history entry
 * (react-router keeps it at `history.state.usr`), never in the address, so a pasted or shared link cannot carry it.
 */
export const FINISH_SETUP_CARD_STATE = { finishSetupFromCard: true } as const;

/** Whether a history entry's state (`window.history.state`) is the card's marker. */
export function arrivedFromFinishSetupCard(historyState: unknown): boolean {
  if (typeof historyState !== "object" || historyState === null || !("usr" in historyState)) return false;
  const usr = historyState.usr;
  return typeof usr === "object" && usr !== null && "finishSetupFromCard" in usr && usr.finishSetupFromCard === true;
}

/**
 * Ask the SDK to publish. On "published" or "already-current" the account's flag is written (dismissed.ts), so the card
 * stays hidden for it on this device. On "needs-one" the owner is sent to TinyCloud One to finish there (setupLink.ts).
 * A refused signature, "unavailable" or a thrown error writes nothing, so the card keeps showing.
 */
export async function publishRegistryRecord(
  tcw: RegistryPublishClient,
  currentOrigin: string,
  openSetupLink: (currentOrigin: string) => Promise<void> = openRegistrySetupLink,
  dismissed: DismissedStore = registryDismissedStore,
): Promise<RegistryPublishOutcome> {
  const outcome = await ensureRegistryRecord(tcw);
  if ((outcome === "published" || outcome === "already-current") && tcw.did) dismissed.write(tcw.did);
  if (outcome === "needs-one") await openSetupLink(currentOrigin);
  return outcome;
}

/**
 * A signed-in page opened with `?finish-setup=registry`: remove the query FIRST (so a reload or a shared link cannot
 * reopen the signature prompt or the notice). When the owner just tapped the card the SDK is asked at once. Otherwise the
 * SDK is not asked and "notice" comes back, so the page can show the public-record notice first. The caller passes only
 * a signed-in client.
 */
export async function runFinishSetupIntent(
  tcw: RegistryPublishClient,
  env: RegistryPublishEnv,
  openSetupLink: (currentOrigin: string) => Promise<void> = openRegistrySetupLink,
  dismissed: DismissedStore = registryDismissedStore,
): Promise<FinishSetupOutcome> {
  if (!hasFinishSetupRegistryIntent(env.location.search)) return "no-intent";
  env.history.replaceState(env.history.state, "", withoutFinishSetupIntent(env.location));
  if (!arrivedFromFinishSetupCard(env.history.state)) return "notice";
  return publishRegistryRecord(tcw, env.location.origin, openSetupLink, dismissed);
}
