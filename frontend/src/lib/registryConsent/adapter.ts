// TC-3547: the typed seam between TinyChat and the SDK's registry publish. The pinned web SDK has no
// `ensureOwnerRegistryRecord` (it ships with js-sdk #1107), so every call checks that the method exists and does
// nothing when it does not. Nothing here fakes the SDK: a missing method is reported as "unsupported".
import type { RegistryPublishHooks } from "@tinyboilerplate/client";
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, lookupOwnerRegistryVerdict } from "@tinycloud/sdk-core";
import { logSession } from "../debugLog";

export type RegistryPublishPreview = Parameters<NonNullable<RegistryPublishHooks["onRegistryPublishConsent"]>>[0];
export type RegistryPublishOutcome = "published" | "already-current" | "declined" | "unavailable";
/** The SDK's outcomes, plus "unsupported": the SDK this build pins does not have the method. */
export type RegistryPublishResult = RegistryPublishOutcome | "unsupported";

/** The slice of the SDK client this adapter touches. Every member is optional: it is checked before use. */
export interface RegistryPublishClient {
  ensureOwnerRegistryRecord?: (options: { ignoreDismissed?: boolean }) => Promise<RegistryPublishOutcome>;
  /** The owner's did:pkh. */
  readonly did?: string;
}

type MaybeClient = RegistryPublishClient | null | undefined;

/** True when this build's SDK can publish. A function-valued member is the whole test. */
export function canPublishRegistryRecord(tcw: MaybeClient): tcw is RegistryPublishClient & Required<Pick<RegistryPublishClient, "ensureOwnerRegistryRecord">> {
  return typeof tcw?.ensureOwnerRegistryRecord === "function";
}

/** The SDK's own error hook, and ours, go to the session log. The SDK never fails a sign-in on these. */
export function reportRegistryPublishError(error: unknown): void {
  logSession("registry_publish", "error", error);
}

/**
 * Ask the SDK to publish the record. Called as a method (the SDK reads `this`). Never throws: the SDK promises not to,
 * and a throw from anywhere else is logged and reported as "unavailable".
 */
export async function ensureRegistryRecord(tcw: MaybeClient, options: { ignoreDismissed?: boolean } = {}): Promise<RegistryPublishResult> {
  if (!canPublishRegistryRecord(tcw)) return "unsupported";
  try {
    return await tcw.ensureOwnerRegistryRecord(options);
  } catch (error) {
    reportRegistryPublishError(error);
    return "unavailable";
  }
}

type VerdictLookup = (subject: string, options: { registryUrl: string }) => Promise<{ status: string; offline?: true }>;

/**
 * Does the registry hold no record for this owner? Only a genuine "unregistered" answers yes: unreachable, an unusable
 * record and a cold-outage guess (`offline`) prove nothing, so they answer no and the banner stays away.
 */
export async function readRegistryUnregistered(
  tcw: MaybeClient,
  lookup: VerdictLookup = lookupOwnerRegistryVerdict,
): Promise<boolean> {
  const subject = tcw?.did;
  if (!subject) return false;
  try {
    const verdict = await lookup(subject, { registryUrl: DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL });
    return verdict.status === "unregistered" && verdict.offline !== true;
  } catch {
    return false;
  }
}
