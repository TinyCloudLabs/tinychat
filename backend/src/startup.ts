import {
  createBackendIdentity,
  type BackendIdentity,
  type BackendIdentityConfig,
} from "@tinyboilerplate/server";
export const TINYCHAT_BACKEND_KV_PREFIX = "ops.tinychat.backend";

type TinychatBackendIdentityInput = Pick<BackendIdentityConfig, "privateKey" | "host">;

export function tinychatBackendIdentityConfig(
  config: TinychatBackendIdentityInput,
): BackendIdentityConfig {
  return {
    privateKey: config.privateKey,
    host: config.host,
    prefix: TINYCHAT_BACKEND_KV_PREFIX,
  };
}

export function createTinychatBackendIdentity(
  config: TinychatBackendIdentityInput,
): Promise<BackendIdentity> {
  return createBackendIdentity(tinychatBackendIdentityConfig(config));
}
