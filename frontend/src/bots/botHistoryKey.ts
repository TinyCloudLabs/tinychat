// Thin SDK adapter for TinyChat's single seeded bot-history key (TC-3823, Route i).
// Keeps every call into the TC-3823 js-sdk surface (`BOT_HISTORY_KEY_PATH` and
// `NamedKeyClient.encrypt(..., { descriptor })`) behind one boundary.
import type { ClientSession, TinyCloudWeb } from "@tinycloud/web-sdk";
import { canonicalizeEncryptionJson } from "@tinycloud/sdk-core";
import { BOT_HISTORY_KEY_PATH } from "@tinycloud/sdk-services";
import type { KeyDescriptor } from "@tinycloud/sdk-services/encryption/named-keys";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import { getAddress } from "viem";
import { encryptionNetworkId } from "../lib/connectors/encryptionGrant";
import { sessionAuthorityEnd } from "./botGrantLifetime";

export { BOT_HISTORY_KEY_PATH };

/** Longest lifetime for the bot-history key approval and signed descriptor: 7 days. */
export const BOT_HISTORY_KEY_MAX_MS = 7 * 86_400_000;

export interface BotHistoryKeyDescriptorPayload {
  v: 1;
  type: "tinychat.bot-history.key-descriptor/v1";
  owner: string;
  networkId: string;
  keyPath: string;
  alg: string;
  keyVersion: number;
  publicEncryptionKey: string;
  kind: "deletable";
  state: "active";
  iat: number;
  exp: number;
}

export interface SignedBotHistoryKeyEnvelope {
  descriptor: BotHistoryKeyDescriptorPayload;
  descriptorSignature: string;
  signerDid: string;
  siwe: string;
  signature: string;
}

const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

/** Exact key URN on the owner's canonical EIP-55 `default` network. */
export function botHistoryKeyUrn(address: string, chainId = 1): string {
  return `${encryptionNetworkId(address, chainId)}/${BOT_HISTORY_KEY_PATH}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * Signs an owner-attested key descriptor with the active session key (no extra wallet prompt).
 * `exp` is capped at `min(sessionEnd, now + 7 d)`, where the session end is the signed one or the renewed one the
 * backend bearer carries for this session key.
 */
export async function signBotHistoryKeyDescriptor(
  tcw: TinyCloudWeb,
  descriptor: KeyDescriptor,
  session: ClientSession,
  nowMs = Date.now(),
  bearer = readBackendSession()?.token ?? null,
): Promise<SignedBotHistoryKeyEnvelope> {
  if (!session.siwe || !session.signature) throw new Error("history_session_missing");
  const sessionEndMs = sessionAuthorityEnd(session.siwe, bearer);
  if (!Number.isFinite(sessionEndMs) || sessionEndMs <= nowMs) throw new Error("history_session_expired");
  if (descriptor.state !== "active" || descriptor.kind !== "deletable") {
    throw new Error("history_key_descriptor_invalid");
  }
  const checksum = getAddress(session.address);
  const owner = `did:pkh:eip155:${session.chainId ?? 1}:${checksum}`;
  const networkId = encryptionNetworkId(session.address, session.chainId ?? 1);
  if (descriptor.networkId !== networkId || descriptor.keyPath !== BOT_HISTORY_KEY_PATH) {
    throw new Error("history_key_descriptor_invalid");
  }
  const iat = Math.floor(nowMs / 1000);
  const exp = Math.floor(Math.min(sessionEndMs, nowMs + BOT_HISTORY_KEY_MAX_MS) / 1000);
  if (exp <= iat) throw new Error("history_session_expired");
  const payload: BotHistoryKeyDescriptorPayload = {
    v: 1,
    type: "tinychat.bot-history.key-descriptor/v1",
    owner,
    networkId,
    keyPath: BOT_HISTORY_KEY_PATH,
    alg: descriptor.alg,
    keyVersion: descriptor.keyVersion,
    publicEncryptionKey: descriptor.publicEncryptionKey,
    kind: "deletable",
    state: "active",
    iat,
    exp,
  };
  const canonical = canonicalizeEncryptionJson({ ...payload });
  const signerDid = /^URI:\s*(did:key:[^\s#]+)/im.exec(session.siwe)?.[1];
  if (!signerDid) throw new Error("history_session_key_missing");
  const sigBytes = await tcw.signSessionBytes(new TextEncoder().encode(canonical));
  return {
    descriptor: payload,
    descriptorSignature: bytesToBase64(sigBytes),
    signerDid,
    siwe: session.siwe,
    signature: session.signature,
  };
}

/** The backend bearer and its account in this browser, or null when signed out. */
export function readBackendSession(): { token: string; address: string } | null {
  if (typeof globalThis.localStorage === "undefined") return null;
  try {
    const store = new SessionStore("xyz.tinycloud.tinychat:session");
    const token = store.getToken();
    const address = store.getAddress()?.toLowerCase();
    return token && address ? { token, address } : null;
  } catch {
    return null;
  }
}

export async function postBotHistoryKeyDescriptor(envelope: SignedBotHistoryKeyEnvelope): Promise<void> {
  const auth = readBackendSession();
  if (!auth || auth.address !== envelope.descriptor.owner.split(":").at(-1)?.toLowerCase()) {
    throw new Error("history_session_changed");
  }
  const response = await fetch(`${base}/api/bots/history/key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("history_key_descriptor_unavailable");
}

interface PublishedRecord {
  owner: string;
  siwe: string;
  keyVersion: number;
  publicEncryptionKey: string;
  renewAfterMs: number;
}

let lastPublished: PublishedRecord | undefined;

/**
 * Signs and posts a fresh key descriptor on every new SIWE session,
 * on every key change (version or public key), or when renewal is due.
 */
export async function publishBotHistoryKeyDescriptor(
  tcw: TinyCloudWeb,
  descriptor: KeyDescriptor,
  options?: {
    post?: (envelope: SignedBotHistoryKeyEnvelope) => Promise<void>;
    nowMs?: number;
  },
): Promise<SignedBotHistoryKeyEnvelope | null> {
  const session = tcw.session();
  if (!session) throw new Error("history_session_missing");
  const nowMs = options?.nowMs ?? Date.now();
  const owner = session.address.toLowerCase();
  const siwe = session.siwe;
  if (!siwe) throw new Error("history_session_missing");
  const same =
    lastPublished !== undefined &&
    lastPublished.owner === owner &&
    lastPublished.siwe === siwe &&
    lastPublished.keyVersion === descriptor.keyVersion &&
    lastPublished.publicEncryptionKey === descriptor.publicEncryptionKey &&
    nowMs < lastPublished.renewAfterMs;
  if (same) return null;

  const post = options?.post ?? postBotHistoryKeyDescriptor;
  const envelope = await signBotHistoryKeyDescriptor(tcw, descriptor, session, nowMs);
  if (!isCurrentHistorySession(tcw, session)) throw new Error("history_session_changed");
  await post(envelope);
  const lifetimeMs = envelope.descriptor.exp * 1000 - nowMs;
  lastPublished = {
    owner,
    siwe,
    keyVersion: descriptor.keyVersion,
    publicEncryptionKey: descriptor.publicEncryptionKey,
    renewAfterMs: nowMs + Math.min(lifetimeMs / 2, 3_600_000),
  };
  return envelope;
}

export function isCurrentHistorySession(tcw: TinyCloudWeb, session: ClientSession): boolean {
  const current = tcw.session();
  return current?.address.toLowerCase() === session.address.toLowerCase()
    && current.chainId === session.chainId
    && current.sessionKey === session.sessionKey
    && current.siwe === session.siwe;
}
