import {
  createBackendIdentity,
  type BackendIdentity,
  type BackendIdentityConfig,
} from "@tinyboilerplate/server";
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
  config: TinychatBackendIdentityInput,
): Promise<BackendIdentity> {
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
