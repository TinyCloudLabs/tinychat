import {
  createBackendIdentity,
  type BackendIdentity,
  type BackendIdentityConfig,
} from "@tinyboilerplate/server";
import { TinyCloudNode } from "@tinycloud/node-sdk";
import { privateKeyToAccount } from "viem/accounts";
export const TINYCHAT_BACKEND_KV_PREFIX = "ops.tinychat.backend";

type TinychatBackendIdentityInput = Pick<
  BackendIdentityConfig,
  "privateKey" | "host"
>;

export function tinychatBackendIdentityConfig(
  config: TinychatBackendIdentityInput,
): BackendIdentityConfig {
  return {
    privateKey: config.privateKey,
    host: config.host,
    prefix: TINYCHAT_BACKEND_KV_PREFIX,
  };
}

export async function createTinychatBackendIdentity(
  config: TinychatBackendIdentityInput & { localValidation?: boolean },
): Promise<BackendIdentity> {
  if (config.localValidation) {
    // Chat authentication needs a signing identity, not backend-owned storage.
    // Leave this client unactivated; the local route guard blocks storage users.
    return {
      node: new TinyCloudNode({ ...tinychatBackendIdentityConfig(config), autoCreateSpace: false }),
      did: `did:pkh:eip155:1:${privateKeyToAccount(config.privateKey as `0x${string}`).address.toLowerCase()}`,
    };
  }
  const identity = await createBackendIdentity(
    tinychatBackendIdentityConfig(config),
  );
  return ensureTinychatBackendSpace(identity);
}

export async function ensureTinychatBackendSpace(
  identity: BackendIdentity,
): Promise<BackendIdentity> {
  // Explicit hosting is idempotent and avoids treating a successful sign-in activation as proof
  // that this app-specific, newly named primary space already exists on the node.
  await identity.node.hostOwnedSpace(TINYCHAT_BACKEND_KV_PREFIX);
  return identity;
}
