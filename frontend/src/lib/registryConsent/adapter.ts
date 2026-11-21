// TC-3547: the typed seam between TinyChat and the SDK's registry publish. The pinned web SDK has no
// `ensureOwnerRegistryRecord` (it ships with js-sdk #1107), so every call checks that the method exists and does
// nothing when it does not. Nothing here fakes the SDK: a missing method is reported as "unsupported".
import type { RegistryPublishHooks } from "@tinyboilerplate/client";
import { logSession } from "../debugLog";

export type RegistryPublishPreview = Parameters<NonNullable<RegistryPublishHooks["onRegistryPublishConsent"]>>[0];
export type RegistryPublishOutcome = "published" | "already-current" | "declined" | "unavailable";
/** The SDK's outcomes, plus "unsupported": the SDK this build pins does not have the method. */
export type RegistryPublishResult = RegistryPublishOutcome | "unsupported";

/** Where the SDK keeps the owner's "Not now", in the account-registry space's KV. The SDK writes it; TinyChat reads it. */
export const REGISTRY_PUBLISH_DISMISSED_KEY = "system/registry-publish/dismissed/v1";

/** The slice of the SDK client this adapter touches. Every member is optional: it is checked before use. */
export interface RegistryPublishClient {
  ensureOwnerRegistryRecord?: (options: { ignoreDismissed?: boolean }) => Promise<RegistryPublishOutcome>;
  readonly accountSpaceId?: string;
  kvForSpace?: (spaceId: string) => {
    get: (key: string) => Promise<{ ok: boolean; data?: { data?: unknown } }>;
  };
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

/**
 * Has the owner answered "Not now" before? Read from the flag the SDK stores in the account-registry KV.
 * Fails open (false) when the flag cannot be read: an unreadable flag proves nothing, same as the SDK's own read.
 */
export async function readRegistryPublishDismissed(tcw: MaybeClient): Promise<boolean> {
  const space = tcw?.accountSpaceId;
  if (!space || typeof tcw?.kvForSpace !== "function") return false;
  try {
    const result = await tcw.kvForSpace(space).get(REGISTRY_PUBLISH_DISMISSED_KEY);
    if (!result.ok) return false;
    const flag = result.data?.data;
    return typeof flag === "object" && flag !== null && (flag as { dismissed?: unknown }).dismissed === true;
  } catch {
    return false;
  }
}
