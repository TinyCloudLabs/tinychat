// TrustBot's finite reads use their own enclave-derived identity and the bots service's call secret.
// Details: TC-4000
import { hkdfSync } from "node:crypto";
import { assertKvResult, createBackendIdentity, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { createDstackKeyClient, type DstackKeyClient } from "../attestation/dstackClient.js";
import { isKvPreconditionFailed } from "../exo/activated-grant.js";
import type { StandingReadRuntime } from "./standing.js";
import { TRUSTBOT_READ_GRANT_KEY_PREFIX, TRUSTBOT_TELEGRAM_READ_GRANT_KEY_PREFIX, TrustBotReadGrants, type ReadGrantStore } from "./grants.js";

/** The read identity's own space prefix. It keeps nothing there; the prefix only names its session. */
const READER_PREFIX = "xyz.tinycloud.tinychat.trustbot-reads";
// Keep the path and HKDF purposes stable across releases within the same dstack app.
const READER_KEY_PATH = "tinychat/trustbot-finite-reads/reader-root/v1";
const SECP256K1_ORDER = Buffer.from("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", "hex");
/** The same floor the bots service sets for its call secret. */
const MIN_CALL_SECRET_CHARS = 32;

export interface TrustBotReadsEnv {
  callSecret: string;
}

/** The settings, or undefined (logged) when reads are off or incomplete. */
export function trustbotReadsFromEnv(env: Record<string, string | undefined>): TrustBotReadsEnv | undefined {
  if (env.TRUSTBOT_READS_ENABLED !== "true") return undefined;
  const callSecret = env.BOTS_BACKEND_CALL_SECRET;
  if (!callSecret || callSecret.length < MIN_CALL_SECRET_CHARS) {
    console.warn("[startup] TRUSTBOT_READS_ENABLED is set but BOTS_BACKEND_CALL_SECRET is missing or malformed; TrustBot reads are off.");
    return undefined;
  }
  return { callSecret };
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
 * Signs in as the enclave-derived reader. Reads stay off if the enclave key is unavailable,
 * sign-in fails or the reader is also used for other grants.
 */
export async function startTrustBotReads(options: {
  backendNode: TinyCloudNode;
  backendDid: string;
  host: string;
  otherDelegateDids: ReadonlyArray<string | undefined>;
  dstack?: DstackKeyClient;
  createIdentity?: typeof createBackendIdentity;
  standing?: StandingReadRuntime;
}): Promise<(TrustBotReadGrants & { telegram: TrustBotReadGrants }) | undefined> {
  let root: Buffer | undefined;
  let privateKey: Buffer | undefined;
  let sealSecret: Buffer | undefined;
  let telegramSeal: Uint8Array | undefined;
  try {
    root = await (options.dstack ?? createDstackKeyClient()).getKey(READER_KEY_PATH);
    if (root.length < 32 || !root.some(byte => byte !== 0)) throw new Error("trustbot_reader_key_unavailable");
    const salt = Buffer.alloc(0);
    privateKey = Buffer.from(hkdfSync("sha256", root, salt, "tinychat.trustbot-finite-reads.reader/v1", 32));
    sealSecret = Buffer.from(hkdfSync("sha256", root, salt, "tinychat.trustbot-finite-reads.store/v1", 32));
    root.fill(0);
    if (!privateKey.some(byte => byte !== 0) || privateKey.compare(SECP256K1_ORDER) >= 0) {
      throw new Error("trustbot_reader_key_invalid");
    }
    const identity = (options.createIdentity ?? createBackendIdentity)({
      privateKey: `0x${privateKey.toString("hex")}`,
      host: options.host,
      prefix: READER_PREFIX,
      autoCreateSpace: false,
    });
    privateKey.fill(0);
    const { node: reader } = await identity;
    const did = reader.did.toLowerCase();
    if ([options.backendDid, ...options.otherDelegateDids].some(other => other?.trim().toLowerCase() === did)) {
      console.error("[startup] TrustBot's read identity is already used for other grants; TrustBot reads are off.");
      return undefined;
    }
    const store = backendGrantStore(options.backendNode);
    // Grants belong to the reader they were issued to and sealed for.
    const readerId = did.slice(did.lastIndexOf(":") + 1);
    telegramSeal = new Uint8Array(hkdfSync("sha256", sealSecret, Buffer.alloc(0), "tinychat.trustbot-telegram-grant/v1", 32));
    const telegram = new TrustBotReadGrants({
      reader, store, host: options.host, areas: ["telegram"], sealSecret: telegramSeal,
      keyPrefix: `${TRUSTBOT_TELEGRAM_READ_GRANT_KEY_PREFIX}v1/${readerId}/`,
    });
    // Standing reads cover the main grant's areas only; the Telegram instance has none.
    return Object.assign(new TrustBotReadGrants({
      reader, store, host: options.host, sealSecret, keyPrefix: `${TRUSTBOT_READ_GRANT_KEY_PREFIX}v1/${readerId}/`,
      standing: options.standing,
    }), { telegram });
  } catch {
    console.error("[startup] TrustBot's enclave read identity is unavailable; TrustBot reads are off.");
    return undefined;
  } finally {
    root?.fill(0);
    privateKey?.fill(0);
    sealSecret?.fill(0);
    telegramSeal?.fill(0);
  }
}
