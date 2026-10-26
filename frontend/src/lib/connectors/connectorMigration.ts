import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet, createTinyCloudWeb, loadAppManifest } from "@tinyboilerplate/client";
import { withEncryptionDecryptGrant } from "./encryptionGrant";

/** A short-lived OpenKey authorization for the one legacy vault read. */
export async function prepareLegacyConnectorRead(input: {
  ownerDid: string;
  backendUrl: string;
  tinycloudHosts: string[];
  openkeyHost: string;
}): Promise<{ signIn(): Promise<TinyCloudWeb>; cleanup(): void }> {
  const wallet = await connectWallet({ host: input.openkeyHost, appName: "Exo" });
  const ownerAddress = input.ownerDid.split(":").at(-1);
  if (!ownerAddress || wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error("Sign in with the same account to move this connector key.");
  }
  const manifest = await loadAppManifest(`${input.backendUrl}/api/manifest`);
  const client = createTinyCloudWeb(wallet.web3Provider, {
    manifest: withEncryptionDecryptGrant(manifest, wallet.address),
    openkey: { client: wallet.openkey },
    includeAccountRegistryPermissions: false,
    tinycloudHosts: input.tinycloudHosts,
    autoCreateSpace: false,
    persistSession: false,
  });
  try {
    await (client as TinyCloudWeb & { prepareSignIn(): Promise<void> }).prepareSignIn();
    return {
      signIn: async () => { await client.signIn(); return client; },
      cleanup: () => client.cleanup(),
    };
  } catch (caught) {
    client.cleanup();
    throw caught;
  }
}
