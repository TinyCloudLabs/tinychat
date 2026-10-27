import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { connectWallet, createTinyCloudWeb, loadAppManifest } from "@tinyboilerplate/client";
import { withEncryptionDecryptGrant } from "./encryptionGrant";
import { isOpenKeyUserDecline, migrationDeclinedMessage, readOrMigrateConnectorKey } from "./namedConnectorSecrets";
import type { ConnectorDescriptor } from "./types";

/** A short-lived OpenKey authorization for the one legacy vault read. */
export async function prepareLegacyConnectorRead(input: {
  ownerDid: string;
  connectorName: string;
  backendUrl: string;
  tinycloudHosts: string[];
  openkeyHost: string;
}): Promise<{ signIn(): Promise<TinyCloudWeb>; cleanup(): void }> {
  const wallet = await connectWallet({ host: input.openkeyHost, appName: "Exo" });
  const ownerAddress = input.ownerDid.split(":").at(-1);
  if (!ownerAddress || wallet.address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new Error(`Sign in with the same account you used for ${input.connectorName} to move this key.`);
  }
  // The key move signs only the legacy vault read, so it uses the backend's manifest, which has no key declaration.
  const manifest = await loadAppManifest(`${input.backendUrl}/api/manifest`);
  const client = createTinyCloudWeb(wallet.web3Provider, {
    manifest: withEncryptionDecryptGrant(manifest, wallet.address),
    openkey: { client: wallet.openkey, mode: "iframe" },
    includeAccountRegistryPermissions: false,
    tinycloudHosts: input.tinycloudHosts,
    autoCreateSpace: false,
    persistSession: false,
  });
  try {
    await client.prepareSignIn();
    return {
      signIn: async () => { await client.signIn(); return client; },
      cleanup: () => client.cleanup(),
    };
  } catch (caught) {
    client.cleanup();
    throw caught;
  }
}

export type ConnectorMoveResult = { ok: true } | { ok: false; message: string };

/**
 * Move one saved connector key from the legacy vault into TinyChat's own named key. The user approves once
 * in OpenKey's review (iframe authorize); nothing changes until the new copy reads back equal. A decline or a
 * failure is a message for the row, never a throw.
 */
export async function moveLegacyConnectorKey(input: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  backendUrl: string;
  openkeyHost: string;
}): Promise<ConnectorMoveResult> {
  const { tcw, descriptor } = input;
  if (!tcw.did) return { ok: false, message: "Sign in again to move this key." };
  let prepared: { signIn(): Promise<TinyCloudWeb>; cleanup(): void } | null = null;
  try {
    prepared = await prepareLegacyConnectorRead({
      ownerDid: tcw.did, connectorName: descriptor.name, backendUrl: input.backendUrl,
      tinycloudHosts: tcw.hosts, openkeyHost: input.openkeyHost,
    });
    const legacy = prepared;
    const result = await readOrMigrateConnectorKey(tcw, descriptor, () => legacy.signIn());
    return result.ok ? { ok: true } : { ok: false, message: result.error.message };
  } catch (caught) {
    return {
      ok: false,
      message: isOpenKeyUserDecline(caught) ? migrationDeclinedMessage(descriptor)
        : caught instanceof Error ? caught.message : "The approval didn't finish. Try again.",
    };
  } finally {
    prepared?.cleanup();
  }
}
