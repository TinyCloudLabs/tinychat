import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  DEFAULT_TINYCLOUD_FALLBACK_HOST,
  parseSignedCompactUcanAttenuation,
  parseSpaceUri,
  resolveRegistryResource,
  TERMINAL_DELEGATION_FACT,
} from "@tinycloud/sdk-core";
import { verifyResourceDestination, type ServiceSession } from "@tinycloud/sdk-services";
import { ServiceContext } from "@tinycloud/sdk-services/context";
import { KVService } from "@tinycloud/sdk-services/kv";
import { didKeyFromEd25519PublicKey, fromBase64Url, toBase64Url } from "@tinycloud/share-envelope";
import { BrowserWasmBindings } from "@tinycloud/web-sdk";
import { CID } from "multiformats/cid";

import { handoffChoicePath } from "../feed/setupChoice";
import { decodeHandoffFragment } from "./codec";

const KEY_PREFIX = "xyz.tinycloud.one/handoff/v1/";
const MAX_RECORD_BYTES = 4096;
const DAY_SECONDS = 86_400;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const BUILT_IN_STORAGES = /^xyz\.tinycloud\.(default|applications|account|secrets|public|agents)$/;
export const ABILITIES = ["apps_data", "account_index", "feed"] as const;

export interface HandoffView {
  agentName: string;
  machineLabel: string;
  connectedAt: number;
  accessExpiresAt: number;
  linkExpiresAt: number;
  abilities: readonly (typeof ABILITIES)[number][];
  appIds: string[];
  appsTruncated: boolean;
  setupChoicePath: string | null;
}

interface HandoffLink {
  owner: string;
  key: string;
  machineLabel: string;
  linkExpiresAt: number;
  session: ServiceSession;
}

declare global {
  interface Window {
    takeHandoffFragment?: () => string;
  }
}

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function verifyHandoff(fragment: string, now = Math.floor(Date.now() / 1000)): HandoffLink {
  const { seed, authorization } = decodeHandoffFragment(fragment);
  try {
    const publicKey = ed25519.getPublicKey(seed);
    const audience = didKeyFromEd25519PublicKey(publicKey);
    // delegateTo emits a WASM UCAN with a terminal fact. The SDK's verifier
    // for issued UCANs checks the exact signature, issuer key and BLAKE3 CID.
    const { cid, payload } = parseSignedCompactUcanAttenuation(authorization);
    const claims = JSON.parse(decoder.decode(fromBase64Url(authorization.split(".")[1]!)));
    const { exp, nbf, prf, fct } = claims;
    if (payload.aud !== audience || !Number.isSafeInteger(exp) || exp <= now || exp > now + DAY_SECONDS ||
        (nbf !== undefined && (!Number.isSafeInteger(nbf) || nbf > now || exp - nbf > DAY_SECONDS)) ||
        !Array.isArray(prf) || prf.length !== 1 || typeof prf[0] !== "string" ||
        CID.parse(prf[0]).toV1().toString() !== prf[0] ||
        !Array.isArray(fct) || fct.length !== 1 ||
        fct[0] == null || Object.keys(fct[0]).length !== 1 ||
        fct[0]["xyz.tinycloud.policy/delegationMode"] !== TERMINAL_DELEGATION_FACT["xyz.tinycloud.policy/delegationMode"]) {
      throw new Error("Invalid handoff proof");
    }

    const issuer = payload.iss.split("#", 1)[0]!;
    const key = KEY_PREFIX + bytesToHex(sha256(utf8.encode(`${issuer}\n${prf[0]}`))).slice(0, 32);
    const resources = Object.entries(payload.att);
    const [resource, actions] = resources[0] ?? ["", {}];
    const suffix = `/kv/${key}`;
    const spaceId = resource.endsWith(suffix) ? resource.slice(0, -suffix.length) : "";
    const space = parseSpaceUri(spaceId);
    const caveats = actions["tinycloud.kv/get"];
    const caveat = caveats?.[0];
    if (resources.length !== 1 || !space?.owner || space.name !== "applications" ||
        Object.keys(actions).length !== 1 || caveats?.length !== 1 || !caveat ||
        typeof caveat !== "object" || Array.isArray(caveat) || Object.keys(caveat).length !== 0) {
      throw new Error("Invalid handoff scope");
    }
    const machineLabel = `Computer ${bytesToHex(sha256(utf8.encode(issuer))).slice(0, 6).toUpperCase()}`;
    return {
      owner: space.owner,
      key,
      machineLabel,
      linkExpiresAt: exp * 1000,
      session: {
        spaceId,
        delegationHeader: { Authorization: authorization },
        delegationCid: cid,
        verificationMethod: audience,
        jwk: { kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: toBase64Url(publicKey), d: toBase64Url(seed) },
      },
    };
  } finally {
    seed.fill(0);
  }
}

function utcTimestamp(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === (value.length === 20 ? value.replace("Z", ".000Z") : value) ? time : NaN;
}

function parseRecord(bytes: Uint8Array, link: HandoffLink): HandoffView | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RECORD_BYTES) return null;
  const record = JSON.parse(decoder.decode(bytes));
  if (!record || typeof record !== "object" || Object.keys(record).length !== 8) return null;
  const { version, agent_name, machine_label, connected_at, access_expires_at, abilities, app_ids, apps_truncated } = record;
  const connectedAt = utcTimestamp(connected_at);
  const accessExpiresAt = utcTimestamp(access_expires_at);
  if (version !== 1 || agent_name !== "TinyCloud agent" || machine_label !== link.machineLabel ||
      !Number.isFinite(connectedAt) || !Number.isFinite(accessExpiresAt) ||
      connectedAt >= accessExpiresAt || accessExpiresAt < link.linkExpiresAt ||
      !Array.isArray(abilities) || (abilities.length !== 2 && abilities.length !== 3) ||
      abilities.some((value, index) => value !== ABILITIES[index]) ||
      !Array.isArray(app_ids) || app_ids.length > 32 ||
      app_ids.some((value, index) => typeof value !== "string" || !APP_ID.test(value) ||
        BUILT_IN_STORAGES.test(value) || (index > 0 && app_ids[index - 1] >= value)) ||
      typeof apps_truncated !== "boolean" || (apps_truncated && app_ids.length !== 32)) return null;
  return {
    agentName: agent_name, machineLabel: machine_label, connectedAt, accessExpiresAt,
    linkExpiresAt: link.linkExpiresAt, abilities, appIds: app_ids, appsTruncated: apps_truncated,
    setupChoicePath: abilities.includes("feed") ? handoffChoicePath(link.key.slice(KEY_PREFIX.length)) : null,
  };
}

const networkFetch: typeof fetch = (input, init) => globalThis.fetch(input, {
  ...init, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
});

async function readRecord({ owner, session, key }: HandoffLink): Promise<Uint8Array | null> {
  const { verdict, hosts } = await resolveRegistryResource(owner, session.spaceId, "read", {
    fetch: networkFetch, timeoutMs: 5000,
  });
  // The SDK uses the managed default only for a verified no-entry verdict.
  const node = verdict.status === "unregistered"
    ? { url: DEFAULT_TINYCLOUD_FALLBACK_HOST, nodeDid: undefined }
    : { url: hosts[0]?.urls[0], nodeDid: hosts[0]?.nodeDid };
  if (!node.url || new URL(node.url).origin !== node.url || !node.url.startsWith("https://")) return null;
  await verifyResourceDestination({ url: node.url, nodeDid: node.nodeDid }, networkFetch);
  const wasm = new BrowserWasmBindings();
  await wasm.ensureInitialized();
  const kv = new KVService({ prefix: "" });
  kv.initialize(new ServiceContext({
    hosts: [node.url],
    invoke: wasm.invoke,
    invokeAny: wasm.invokeAny,
    fetch: (url, init) => {
      if (new URL(url).origin !== node.url) throw new Error("Invalid handoff destination");
      return networkFetch(url, init);
    },
    retryPolicy: { maxAttempts: 1 },
    session,
  }));
  const result = await kv.get<Uint8Array>(key, {
    source: "network", binary: true, maxResponseBytes: MAX_RECORD_BYTES, timeout: 5000,
  });
  return result.ok ? result.data.data : null;
}

export async function openHandoff(
  fragment: string | undefined,
  read: (link: HandoffLink) => Promise<Uint8Array | null> = readRecord,
): Promise<HandoffView | null> {
  if (!fragment) return null;
  try {
    const link = verifyHandoff(fragment);
    const bytes = await read(link);
    return bytes && Date.now() < link.linkExpiresAt ? parseRecord(bytes, link) : null;
  } catch {
    // Never surface the credential or an SDK error that could carry it.
    return null;
  }
}
