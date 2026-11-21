// TC-3547: when TinyChat asks the SDK to publish the owner's registry record, and the `finish-setup` link that asks it
// again after a "Not now". Everything stays inert while REGISTRY_CONSENT_MODAL_ENABLED is false or the pinned SDK has
// no `ensureOwnerRegistryRecord`.
import { isLegacyOrigin, CANONICAL_ORIGIN } from "../originMove";
import { ensureRegistryRecord, canPublishRegistryRecord, type RegistryPublishClient, type RegistryPublishResult } from "./adapter";
import { REGISTRY_CONSENT_MODAL_ENABLED } from "./copy";
import { registryDismissedStore, type DismissedStore } from "./dismissed";

/** The SDK's `FINISH_SETUP_REGISTRY_INTENT` ("finish-setup=registry"), matched as a name and a fixed value. */
const INTENT_PARAM = "finish-setup";
const INTENT_VALUE = "registry";
/** The query the Home card navigates to: this module's own link, so the card runs the same path as a pasted link. */
export const FINISH_SETUP_INTENT_SEARCH = `?${INTENT_PARAM}=${INTENT_VALUE}`;

export type RegistryPublishEnv = {
  location: Pick<Location, "origin" | "hostname" | "pathname" | "search" | "hash">;
  history: Pick<History, "replaceState" | "state">;
};

/** TinyCloud's own pages. The SDK's explicit publish has no origin check of its own, so the host checks. */
export function isFirstPartyPublishOrigin(location: Pick<Location, "origin" | "hostname">): boolean {
  return location.origin === CANONICAL_ORIGIN || isLegacyOrigin(location);
}

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

export type FinishSetupOutcome = RegistryPublishResult | "no-intent" | "off" | "not-first-party";

/**
 * A signed-in first-party page opened with `?finish-setup=registry`: remove the query FIRST (so a reload or a shared
 * link cannot reopen the consent), then ask the SDK to publish past an earlier "Not now". The caller passes only a
 * signed-in client.
 */
export async function runFinishSetupIntent(
  tcw: RegistryPublishClient | null | undefined,
  env: RegistryPublishEnv,
  enabled: boolean = REGISTRY_CONSENT_MODAL_ENABLED,
): Promise<FinishSetupOutcome> {
  if (!enabled || !canPublishRegistryRecord(tcw)) return "off";
  if (!hasFinishSetupRegistryIntent(env.location.search)) return "no-intent";
  if (!isFirstPartyPublishOrigin(env.location)) return "not-first-party";
  env.history.replaceState(env.history.state, "", withoutFinishSetupIntent(env.location));
  return ensureRegistryRecord(tcw, { ignoreDismissed: true });
}

/**
 * After a fresh first-party sign-in: ask the SDK to publish if the owner has no record. TinyChat signs in with
 * `autoBootstrapAccount: false`, which is also what stops the SDK from doing this itself at sign-in, so the host asks.
 * The host skips it after a "Not now" (dismissed.ts); the SDK checks the registry and asks consent. A `finish-setup` link on the page is left to
 * `runFinishSetupIntent`, so the two never ask at once.
 */
export async function runSignInRegistryPublish(
  tcw: RegistryPublishClient | null | undefined,
  env: RegistryPublishEnv,
  enabled: boolean = REGISTRY_CONSENT_MODAL_ENABLED,
  dismissed: DismissedStore = registryDismissedStore,
): Promise<RegistryPublishResult | "off" | "not-first-party" | "deferred-to-link" | "dismissed"> {
  if (!enabled || !canPublishRegistryRecord(tcw)) return "off";
  if (!isFirstPartyPublishOrigin(env.location)) return "not-first-party";
  if (hasFinishSetupRegistryIntent(env.location.search)) return "deferred-to-link";
  // An owner who pressed "Not now" before is not asked at sign-in again; the finish-setup link is how they come back.
  if (tcw.did && dismissed.read(tcw.did)) return "dismissed";
  return ensureRegistryRecord(tcw);
}
