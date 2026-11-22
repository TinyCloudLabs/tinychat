import {
  createBackendIdentity,
  type BackendIdentity,
  type BackendIdentityConfig,
} from "@tinyboilerplate/server";
import { TinyCloudNode, type Manifest, type PermissionEntry } from "@tinycloud/node-sdk";
import { resolveManifest } from "@tinycloud/node-sdk/core";
import { privateKeyToAccount } from "viem/accounts";
import { BACKEND_KV_ROOTS } from "./backend-kv-roots.js";
export const TINYCHAT_BACKEND_KV_PREFIX = "ops.tinychat.backend";

const backendKv = (path: string, actions: string[]): PermissionEntry => ({
  service: "tinycloud.kv",
  space: TINYCHAT_BACKEND_KV_PREFIX,
  path,
  actions,
  skipPrefix: true,
});

/**
 * The backend's own session: the key roots it reads and writes in its own space, nothing in
 * any other space. Keys are written verbatim (no prefix). Data in users' spaces is reached
 * through the delegations users grant, never through this session. Startup checks it against
 * BACKEND_KV_ROOTS (backend-kv-roots.ts) before signing in.
 */
export const TINYCHAT_BACKEND_MANIFEST: Manifest = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.tinychat.backend",
  name: "TinyChat backend",
  space: TINYCHAT_BACKEND_KV_PREFIX,
  prefix: "",
  defaults: false,
  includePublicSpace: false,
  // Matches the session lifetime (SESSION_EXPIRATION_MS) set in createBackendIdentity.
  expiry: "30d",
  permissions: [
    // Users' transcript-writer and exo-sync grants (delegation-store, exo/grant-holders).
    backendKv("delegations/", ["get", "put", "del", "list"]),
    // Webhook tokens, config, queues (pending/dead/corrupt), purge ledger, disabled flags, ingest lease and cohort.
    backendKv("webhooks/", ["get", "put", "del", "list"]),
    // Connector content store (services/content-store).
    backendKv("connector-content/", ["get", "put", "del", "list"]),
    backendKv("connector-content-index/", ["get", "put", "del", "list"]),
    backendKv("connector-content-key-failure/", ["get", "put", "del", "list"]),
    backendKv("connector-content-replay-tombstone/", ["get", "put", "del", "list"]),
    backendKv("connector-content-continuity/v1", ["get", "put"]),
    // Connector credentials (services/credential-store).
    backendKv("credentials/", ["get", "put", "del", "list"]),
    // Transcriber index and delivery state.
    backendKv("transcriber/", ["get", "put", "list"]),
    // Hosted AssemblyAI spool identity.
    backendKv("assemblyai/hosted/spool-identity", ["get", "put"]),
    // Calendar auto-join connections, status, occurrences, sends and captures.
    backendKv("calendar-autojoin/v1/", ["get", "put", "del", "list"]),
    // Bot-history grants.
    backendKv("bot-history/grants/", ["get", "put", "del", "list"]),
    // Which bots each owner has (bots-registry).
    backendKv("bots/registry/", ["get", "put", "list"]),
    // TrustBot's read grants, sealed (trustbot-reads/grants.ts).
    backendKv("trustbot/read-grants/", ["get", "put", "del"]),
    // Exo mirror jobs, ledger, held jobs and source locks (exoBackendKv).
    backendKv("xyz.tinycloud.tinychat/exo/v1/", ["get", "put", "del", "list"]),
  ],
};

/**
 * Throws, naming each root, when `manifest` leaves out a key root the backend uses in its own
 * space. Startup runs this before signing in, so a missing root stops the backend at boot instead
 * of failing its first read or write.
 */
export function assertBackendManifestCoversKvRoots(
  manifest: Manifest,
  roots: readonly string[] = BACKEND_KV_ROOTS,
): void {
  const granted = resolveManifest(manifest).resources
    .filter((resource) => resource.service === "tinycloud.kv" && resource.space === TINYCHAT_BACKEND_KV_PREFIX)
    .map((resource) => resource.path);
  // A granted path covers a root when it is the whole space, the same key, or a folder above it.
  const missing = roots.filter(
    (root) => !granted.some((path) => path === "" || path === root || (path.endsWith("/") && root.startsWith(path))),
  );
  if (missing.length > 0) {
    throw new Error(
      `TinyChat backend manifest does not cover key roots the backend uses: ${missing.join(", ")}. ` +
        "Add them to TINYCHAT_BACKEND_MANIFEST in backend/src/startup.ts.",
    );
  }
}

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

/** What startup signs in with: the backend's config and its manifest, checked against the roots it uses. */
export function tinychatBackendSignInConfig(config: TinychatBackendIdentityInput): BackendIdentityConfig {
  assertBackendManifestCoversKvRoots(TINYCHAT_BACKEND_MANIFEST);
  return { ...tinychatBackendIdentityConfig(config), manifest: TINYCHAT_BACKEND_MANIFEST };
}

export async function createTinychatBackendIdentity(
  config: TinychatBackendIdentityInput & { localValidation?: boolean },
): Promise<BackendIdentity> {
  if (config.localValidation) {
    // Chat authentication needs a signing identity, not backend-owned storage.
    // Leave this client unactivated; the local route guard blocks storage users.
    return {
      node: new TinyCloudNode({ ...tinychatBackendIdentityConfig(config), autoCreateSpace: false, includeAccountRegistryPermissions: false }),
      did: `did:pkh:eip155:1:${privateKeyToAccount(config.privateKey as `0x${string}`).address.toLowerCase()}`,
    };
  }
  const identity = await createBackendIdentity(tinychatBackendSignInConfig(config));
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
