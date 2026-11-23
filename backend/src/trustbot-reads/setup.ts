// Startup for TrustBot's reads (TC-3792): on only with TRUSTBOT_READS_ENABLED=true, a read identity of its own
// (TRUSTBOT_READ_PRIVATE_KEY) and the bots service's call secret (BOTS_BACKEND_CALL_SECRET). The read identity must
// differ from every other identity owners delegate to, so no other grant can be used for TrustBot's reads.
// Details: TC-3792
import { assertKvResult, createBackendIdentity, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { isKvPreconditionFailed } from "../exo/activated-grant.js";
import type { StandingReadRuntime } from "./standing.js";
import { TrustBotReadGrants, type ReadGrantStore } from "./grants.js";

/** The read identity's own space prefix. It keeps nothing there; the prefix only names its session. */
const READER_PREFIX = "xyz.tinycloud.tinychat.trustbot-reads";
/** The same floor the bots service sets for its call secret. */
const MIN_CALL_SECRET_CHARS = 32;

export interface TrustBotReadsEnv {
  privateKey: `0x${string}`;
  callSecret: string;
}

/** The settings, or undefined (logged) when reads are off or incomplete. */
export function trustbotReadsFromEnv(env: Record<string, string | undefined>): TrustBotReadsEnv | undefined {
  if (env.TRUSTBOT_READS_ENABLED !== "true") return undefined;
  const privateKey = env.TRUSTBOT_READ_PRIVATE_KEY?.trim();
  const callSecret = env.BOTS_BACKEND_CALL_SECRET;
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey) || !callSecret || callSecret.length < MIN_CALL_SECRET_CHARS) {
    console.warn("[startup] TRUSTBOT_READS_ENABLED is set but TRUSTBOT_READ_PRIVATE_KEY or BOTS_BACKEND_CALL_SECRET is missing or malformed; TrustBot reads are off.");
    return undefined;
  }
  return { privateKey: privateKey as `0x${string}`, callSecret };
}

/** The backend's own key-value store for the sealed grants. */
export function backendGrantStore(node: TinyCloudNode): ReadGrantStore {
  return {
    async get(key) {
      return withSessionRefresh(node, async () => {
        const result = await node.kv.get<string>(key, { source: "network", maxResponseBytes: 256 * 1024 });
        if (isKvMissingKeyResult(result, key)) return undefined;
        assertKvResult(result);
        if (!result.ok) return undefined;
        const { data: value, headers } = result.data;
        const etag = headers?.etag;
        if (typeof value !== "string" || !etag || etag.startsWith("W/")) throw new Error("trustbot_read_record_invalid");
        return { value, etag };
      });
    },
    async put(key, value, condition) {
      return withSessionRefresh(node, async () => {
        const result = await node.kv.put(key, value, condition);
        if (isKvPreconditionFailed(result)) return false;
        assertKvResult(result);
        return true;
      });
    },
    async delete(key, condition) {
      return withSessionRefresh(node, async () => {
        const result = await node.kv.delete(key, condition);
        if (isKvPreconditionFailed(result) || isKvMissingKeyResult(result, key)) return false;
        assertKvResult(result);
        return true;
      });
    },
  };
}

/**
 * Signs in as the read identity and returns the grants module, or undefined (logged) when the identity is one owners
 * already delegate to for something else: the backend's own DID or the MCP chat service DID.
 */
export async function startTrustBotReads(settings: TrustBotReadsEnv, options: {
  backendNode: TinyCloudNode;
  backendDid: string;
  host: string;
  otherDelegateDids: ReadonlyArray<string | undefined>;
  standing?: StandingReadRuntime;
}): Promise<TrustBotReadGrants | undefined> {
  let reader: TinyCloudNode;
  try {
    ({ node: reader } = await createBackendIdentity({ privateKey: settings.privateKey, host: options.host, prefix: READER_PREFIX, autoCreateSpace: false }));
  } catch {
    console.error("[startup] TrustBot's read identity could not sign in; TrustBot reads are off.");
    return undefined;
  }
  const did = reader.did.toLowerCase();
  if ([options.backendDid, ...options.otherDelegateDids].some(other => other?.trim().toLowerCase() === did)) {
    console.error("[startup] TRUSTBOT_READ_PRIVATE_KEY names an identity already used for other grants; TrustBot reads are off.");
    return undefined;
  }
  const sealSecret = Buffer.from(settings.privateKey.slice(2), "hex");
  return new TrustBotReadGrants({ reader, store: backendGrantStore(options.backendNode), host: options.host, sealSecret, standing: options.standing });
}
