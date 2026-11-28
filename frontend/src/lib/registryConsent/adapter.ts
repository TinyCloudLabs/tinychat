// TC-3547: the typed seam between TinyChat and the SDK's registry publish. The SDK's own signature prompt (wallet or
// OpenKey) is the owner's consent; this file only calls it and reads the verdict.
import type { RegistryPublishOutcome } from "@tinycloud/web-sdk";
import { DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL, lookupOwnerRegistryVerdict } from "@tinycloud/sdk-core";
import { logSession } from "../debugLog";

export type { RegistryPublishOutcome };

/** The slice of the SDK client this adapter touches. */
export interface RegistryPublishClient {
  ensureOwnerRegistryRecord(): Promise<RegistryPublishOutcome>;
  /** The owner's did:pkh. */
  readonly did?: string;
}

/** The SDK's own error hook, and ours, go to the session log. The SDK never fails a sign-in on these. */
export function reportRegistryPublishError(error: unknown): void {
  logSession("registry_publish", "error", error);
}

/**
 * Ask the SDK to publish the record. Called as a method (the SDK reads `this`). Never throws: the SDK promises not to,
 * and a throw from anywhere else is logged and reported as "unavailable".
 */
export async function ensureRegistryRecord(tcw: RegistryPublishClient): Promise<RegistryPublishOutcome> {
  try {
    return await tcw.ensureOwnerRegistryRecord();
  } catch (error) {
    reportRegistryPublishError(error);
    return "unavailable";
  }
}

type VerdictLookup = (subject: string, options: { registryUrl: string }) => Promise<{ status: string; offline?: true }>;

/**
 * Does the registry hold no record for this owner? Only a genuine "unregistered" answer says yes: unreachable, an unusable
 * record and a cold-outage guess (`offline`) prove nothing, so they answer no and the banner stays away.
 */
export async function readRegistryUnregistered(
  tcw: Pick<RegistryPublishClient, "did"> | null | undefined,
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
