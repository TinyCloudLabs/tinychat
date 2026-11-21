// A fake of the SDK surface TC-3547 touches, with the SDK's documented behavior around the consent callback:
// consent answered false stores "Not now"; a throw is declined without storing it; and a sign-out between the question
// and the answer (the SDK's sign-out counter moved) ends the flow before any write.
import type { RegistryPublishClient, RegistryPublishOutcome, RegistryPublishPreview } from "./adapter";
import { REGISTRY_PUBLISH_DISMISSED_KEY } from "./adapter";

export const PREVIEW: RegistryPublishPreview = {
  subject: "did:pkh:eip155:1:0x00000000000000000000000000000000000abcd1",
  nodeDid: "did:web:node.tinycloud.xyz",
  nodeOrigin: "https://node.tinycloud.xyz",
  space: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000abcd1:default",
};

export function fakeSdk(consent?: (preview: RegistryPublishPreview) => Promise<boolean>) {
  const kv = new Map<string, unknown>();
  const calls: Array<{ options: { ignoreDismissed?: boolean } }> = [];
  const log: string[] = [];
  let signOutCount = 0;
  const client = {
    accountSpaceId: "tinycloud:pkh:eip155:1:0x00000000000000000000000000000000000abcd1:account-registry",
    kvForSpace: () => ({
      get: async (key: string) => ({ ok: true, data: { data: kv.get(key) } }),
    }),
    signOut: () => { signOutCount += 1; log.push("sign-out"); return Promise.resolve(); },
    async ensureOwnerRegistryRecord(options: { ignoreDismissed?: boolean }): Promise<RegistryPublishOutcome> {
      calls.push({ options });
      log.push("ensure");
      if (!options.ignoreDismissed && (kv.get(REGISTRY_PUBLISH_DISMISSED_KEY) as { dismissed?: boolean } | undefined)?.dismissed) return "declined";
      const signOutsAtEntry = signOutCount;
      let approved: boolean;
      try {
        approved = await consent!(PREVIEW);
      } catch {
        return "declined";
      }
      if (signOutCount !== signOutsAtEntry) return "unavailable";
      if (!approved) {
        kv.set(REGISTRY_PUBLISH_DISMISSED_KEY, { dismissed: true });
        return "declined";
      }
      return "published";
    },
  } satisfies RegistryPublishClient & { signOut(): Promise<void> };
  return { client, kv, calls, log };
}
