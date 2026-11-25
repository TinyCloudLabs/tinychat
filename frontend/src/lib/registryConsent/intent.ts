// TC-3547: the `finish-setup=registry` link, and the Home card that navigates to it. The SDK publishes only from TinyCloud
// One and Home (an exact origin match) and signs nothing elsewhere, so the host asks every time and acts on the verdict.
import { ensureRegistryRecord, type RegistryPublishClient, type RegistryPublishOutcome } from "./adapter";
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

export type FinishSetupOutcome = RegistryPublishOutcome | "no-intent";

/**
 * A signed-in page opened with `?finish-setup=registry`: remove the query FIRST (so a reload or a shared link cannot
 * reopen the signature prompt), then ask the SDK to publish. On "needs-one" the owner is sent to TinyCloud One to finish
 * there (setupLink.ts). The caller passes only a signed-in client.
 */
export async function runFinishSetupIntent(
  tcw: RegistryPublishClient,
  env: RegistryPublishEnv,
  openSetupLink: (currentOrigin: string) => Promise<void> = openRegistrySetupLink,
): Promise<FinishSetupOutcome> {
  if (!hasFinishSetupRegistryIntent(env.location.search)) return "no-intent";
  env.history.replaceState(env.history.state, "", withoutFinishSetupIntent(env.location));
  const outcome = await ensureRegistryRecord(tcw);
  if (outcome === "needs-one") await openSetupLink(env.location.origin);
  return outcome;
}
