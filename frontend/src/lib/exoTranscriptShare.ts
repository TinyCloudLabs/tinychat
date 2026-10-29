import { createContext } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { NamedKeyClient } from "@tinycloud/node-sdk/encryption-keys";
import {
  DEFAULT_SHARE_LIFETIME_MS, assertAddressedShareFits, canonicalShareFilename, canonicalize,
  hasUnsafeFilenameCodePoint, historyRecordForPublishedShare, prepareAddressedShare, publishAddressedShare,
} from "@tinycloud/share-sdk";
import type { AddressedPublishAuthority, PublishedShare, PublishedShareDeliveryMaterial } from "@tinycloud/share-sdk";
import { encryptionBase64Decode, encryptionBase64Encode } from "@tinycloud/sdk-core";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { CONNECTORS_KV_PREFIX, CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import {
  EXPLORER_MEETING_SOURCES, transcriptCopyText,
} from "@/lib/connectors/meetingExplorer";
import type { MeetingListItem, MeetingMetadataRead, TranscriptRead } from "@/lib/connectors/meetingExplorer";
import { encryptionNetworkId } from "@/lib/connectors/encryptionGrant";
import { runOnSpace } from "@/lib/spaceQueue";
import { SHARE_ORIGIN } from "@/home/shareApps";
import { applyWordFixesToSentences } from "@/lib/wordFixes/wordFixes";

class TranscriptShareError extends Error {}

/** Registered Share sources bind decoded wrapped-key bytes; the envelope's encryptedSymmetricKeyHash instead binds its canonical JSON string. */
export function rawWrappedKeyDigest(wrappedKey: string): string {
  let bytes: Uint8Array;
  try {
    bytes = encryptionBase64Decode(wrappedKey);
    if (bytes.length === 0 || encryptionBase64Encode(bytes) !== wrappedKey) throw new Error();
  } catch {
    // Never include wrapped material in a caller-visible failure.
    throw new TranscriptShareError("Wrapped-key base64 is not canonical.");
  }
  return bytesToHex(sha256(bytes));
}

/** The view owns only the conditional action beside Copy; NoteDetail owns review and execution. */
export const ExoTranscriptShareContext = createContext<{ open: () => void; busy: boolean; signInRequired: boolean } | null>(null);

type ShareItem = MeetingListItem & { onPhone?: true; saving?: true };
export interface TranscriptShareSnapshot {
  readonly id: string;
  readonly source: string;
  readonly sourceId: string;
  readonly title: string;
  readonly rawText: string;
  readonly text: string;
}
interface ShareAccount {
  readonly spaceId: string;
  /** The SDK's established session signer, not the storage owner's pkh DID. */
  readonly holderDid: string;
  readonly sessionDid: string;
  readonly storageOwnerDid: string;
  readonly encryptionNetwork: string;
}
export interface TranscriptShareReview {
  readonly shareId: string;
  readonly recipient: string;
  readonly expiresAt: number;
  readonly filename: string;
  readonly account: ShareAccount;
  readonly snapshot: TranscriptShareSnapshot;
}
export interface TranscriptShareOrigins {
  readonly apiOrigin: string;
  readonly shareOrigin: string;
  readonly localOnly?: boolean;
}

const SNAPSHOTS_PREFIX = `${CONNECTORS_KV_PREFIX}/share-snapshots`;
const MEDIA_TYPE = "text/plain;charset=utf-8";
const FILENAME = "transcript.txt";
const MAX_DISPLAY_FILENAME_BYTES = 128;
const loopback = (hostname: string) => hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

/** No local/device fallback or unsupported connector can become a Share source. */
export function transcriptShareSnapshot(
  item: ShareItem | null, metadata: MeetingMetadataRead | undefined, transcript: TranscriptRead | undefined,
  applyWordFixes: (text: string) => string = (text) => text,
): TranscriptShareSnapshot | null {
  if (!item || item.onPhone || item.saving || !EXPLORER_MEETING_SOURCES.includes(item.source)
    || metadata?.status !== "ok" || metadata.metadata.transcription_outcome === "no_speech"
    || transcript?.status !== "ok" || !item.id || !item.sourceId) return null;
  const pasted = item.metadata?.capture === "pasted" ? metadata.metadata.transcript_text : undefined;
  const rawText = typeof pasted === "string" ? pasted : transcriptCopyText(transcript.sentences);
  if (!rawText.trim()) return null;
  const text = typeof pasted === "string" ? applyWordFixes(pasted)
    : transcriptCopyText(applyWordFixesToSentences(transcript.sentences, applyWordFixes));
  return Object.freeze({ id: item.id, source: item.source, sourceId: item.sourceId,
    title: item.title ?? "Transcript", rawText, text });
}

function shareAccount(tcw: TinyCloudWeb): ShareAccount {
  const session = tcw.session?.();
  const spaceId = tcw.spaceId;
  if (!session || !spaceId || !tcw.sessionDid || !tcw.credentialHolderDid) throw new TranscriptShareError("The signed-in account is unavailable.");
  const network = encryptionNetworkId(session.walletAddress, session.chainId);
  const owner = network.slice("urn:tinycloud:encryption:".length, -":default".length);
  if (tcw.credentialSpaceOwnerDid(spaceId) !== owner) throw new TranscriptShareError("Sharing requires the current account's own space.");
  return Object.freeze({ spaceId, holderDid: tcw.credentialHolderDid, sessionDid: tcw.sessionDid,
    storageOwnerDid: owner, encryptionNetwork: network });
}

/** These are existing grants only. Share never escalates KV, SQL, decrypt, or native ceilings. */
export function transcriptShareUnavailable(tcw: TinyCloudWeb): string | null {
  try {
    const account = shareAccount(tcw);
    for (const action of ["get", "put"]) {
      if (!tcw.hasPermissions([{ service: "tinycloud.kv", path: `${SNAPSHOTS_PREFIX}/`, actions: [action], skipPrefix: true }])) {
        return `Sharing needs the existing tinycloud.kv/${action} capability under ${CONNECTORS_KV_PREFIX}/.`;
      }
    }
    if (!tcw.hasPermissions([{ service: "tinycloud.sql", path: CONNECTORS_SQL_DB_NAME, actions: ["read"], skipPrefix: true }])) {
      return "Sharing needs the existing tinycloud.sql/read capability for TinyChat connectors.";
    }
    if (!tcw.hasPermissions([{ service: "tinycloud.encryption", path: account.encryptionNetwork, actions: ["decrypt"] }])) {
      return "Sharing needs the existing owner's default-network tinycloud.encryption/decrypt capability. This session cannot add it here.";
    }
    return null;
  } catch {
    return "Sharing needs an existing signed-in owner session with TinyChat connectors and encryption capabilities.";
  }
}

/** beta.21 cannot request an owner-signed Share-key grant from a restored or disconnected session. */
export function transcriptShareNeedsSignIn(tcw: TinyCloudWeb): boolean {
  return tcw.sessionRestoreStatus === "restored" || tcw.isSessionOnly || !tcw.isWalletConnected;
}

function transcriptShareFilename(title: string): string {
  let filename = "";
  let byteLength = 0;
  for (const character of title.normalize("NFC").trim()) {
    const safe = character === "/" || character === "\\" || hasUnsafeFilenameCodePoint(character) ? "-" : character;
    const point = safe.codePointAt(0)!;
    const bytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (byteLength + bytes > MAX_DISPLAY_FILENAME_BYTES) break;
    filename += safe;
    byteLength += bytes;
  }
  filename = filename.trim();
  return canonicalShareFilename(!filename || filename === "." || filename === ".." ? "Transcript" : filename);
}

/** Pure recipient normalization/validation, before consent, key creation or writes. */
export function prepareTranscriptShare(
  tcw: TinyCloudWeb, snapshot: TranscriptShareSnapshot, recipient: string,
  now = Date.now(), shareId = crypto.randomUUID(),
): TranscriptShareReview {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(shareId)) throw new TranscriptShareError("Invalid share identifier.");
  if (!snapshot.text.trim()) throw new TranscriptShareError("The persisted transcript is empty.");
  const filename = transcriptShareFilename(snapshot.title);
  const prepared = prepareAddressedShare({ target: { kind: "email", address: recipient }, actions: ["read"],
    policyActions: ["tinycloud.kv/get"], filename });
  if (prepared.target.kind !== "email") throw new TranscriptShareError("An exact recipient email is required.");
  return Object.freeze({ shareId, recipient: prepared.target.address, expiresAt: now + DEFAULT_SHARE_LIFETIME_MS, filename,
    account: shareAccount(tcw), snapshot: Object.freeze({ ...snapshot }) });
}

/** Environment overrides reach the actual caller; a loopback page cannot fall through to production. */
export function transcriptShareOrigins(overrides?: TranscriptShareOrigins): TranscriptShareOrigins {
  const env = import.meta.env;
  const localPage = typeof location !== "undefined" && location.protocol === "http:" && loopback(location.hostname);
  return {
    apiOrigin: overrides?.apiOrigin ?? env?.VITE_SHARE_API_ORIGIN ?? "https://api.tinycloud.xyz",
    shareOrigin: overrides?.shareOrigin ?? env?.VITE_SHARE_ORIGIN ?? SHARE_ORIGIN,
    localOnly: localPage || overrides?.localOnly === true,
  };
}

export function validateTranscriptShareOrigins(origins: TranscriptShareOrigins, nodeOrigin?: string): TranscriptShareOrigins {
  for (const value of [origins.apiOrigin, origins.shareOrigin, ...(nodeOrigin === undefined ? [] : [nodeOrigin])]) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname)))) {
      throw new TranscriptShareError("Sharing requires canonical HTTPS or loopback service origins.");
    }
    if (origins.localOnly && !loopback(url.hostname)) throw new TranscriptShareError("Local sharing requires loopback API, renderer and Node origins.");
  }
  return origins;
}

interface TranscriptShareInput {
  readonly tcw: TinyCloudWeb;
  readonly review: TranscriptShareReview;
  readonly origins: TranscriptShareOrigins;
  /** Checked after every await and immediately inside each queued write/authority operation. */
  readonly isCurrent: () => boolean;
  readonly readPersisted: () => Promise<TranscriptShareSnapshot | null>;
  readonly now?: () => number;
}
const SDK_OPERATIONS = { publish: publishAddressedShare, assertFits: assertAddressedShareFits };

/**
 * This is an Exo storage/authority adapter, not a second Share transport.
 * Tests substitute only the two effectful SDK boundaries; production uses the public publisher.
 */
export async function publishTranscriptShare(
  input: TranscriptShareInput, operations: typeof SDK_OPERATIONS = SDK_OPERATIONS,
): Promise<{ status: "declined" } | { status: "published"; published: PublishedShare; receiptPath: string }> {
  const { tcw, review } = input;
  const now = input.now ?? Date.now;
  let expectedHost: string | undefined;
  const check = () => {
    if (!input.isCurrent()) throw new TranscriptShareError("The note or account changed. Review the transcript again.");
    if (transcriptShareNeedsSignIn(tcw)) throw new TranscriptShareError("Sign in again to share");
    const account = shareAccount(tcw);
    if (Object.keys(review.account).some((key) => account[key as keyof ShareAccount] !== review.account[key as keyof ShareAccount])) {
      throw new TranscriptShareError("The account changed. Review the transcript again.");
    }
    if (expectedHost !== undefined && tcw.hosts[0] !== expectedHost) throw new TranscriptShareError("The account's owner Node changed. Review the transcript again.");
    if (now() >= review.expiresAt) throw new TranscriptShareError("The share review expired. Review the transcript again.");
  };
  let stage = "checking the existing session";
  try {
    check();
    const unavailable = transcriptShareUnavailable(tcw);
    if (unavailable) throw new TranscriptShareError(unavailable);
    // Guard the configured host before even activeNodeIdentity can fetch /info.
    const host = expectedHost = tcw.hosts[0];
    if (!host) throw new TranscriptShareError("The existing owner Node is unavailable.");
    validateTranscriptShareOrigins(input.origins, host);
    const snapshot = await input.readPersisted();
    check();
    if (!snapshot || canonicalize(snapshot) !== canonicalize(review.snapshot)) throw new TranscriptShareError("The persisted transcript changed. Review it again.");
    const node = await tcw.activeNodeIdentity();
    check();
    validateTranscriptShareOrigins(input.origins, node.origin);
    if (node.origin !== host) throw new TranscriptShareError("The account's owner Node changed. Review the transcript again.");
    stage = "resolving the existing owner encryption network";
    const networkId = review.account.encryptionNetwork;
    const network = await tcw.getEncryptionNetwork(networkId);
    check();
    if (!network || network.networkId !== networkId || network.ownerDid !== review.account.storageOwnerDid || network.state !== "active") {
      throw new TranscriptShareError("The existing owner's default encryption network is missing or inactive. Sharing will not create one.");
    }
    const path = `${SNAPSHOTS_PREFIX}/${review.shareId}/${FILENAME}.enc.json`;
    const keyPath = `share/${review.shareId}`;
    const keys: Pick<NamedKeyClient, "getPublicKey" | "createKey" | "encrypt"> = tcw.keys;
    stage = "checking named-key support";
    // Public descriptor lookup performs the SDK feature gate; no authenticated describe/ensureKey.
    await keys.getPublicKey(keyPath, { networkId });
    check();
    const request = { target: { kind: "email" as const, address: review.recipient }, actions: ["read" as const],
      policyActions: ["tinycloud.kv/get" as const], filename: review.filename };
    const prepared = prepareAddressedShare(request);
    const byteLength = new TextEncoder().encode(snapshot.text).byteLength;
    await operations.assertFits({ ...request, shareId: review.shareId, ownerDid: review.account.holderDid,
      nodeOrigin: node.origin, nodeAudience: node.nodeDid, enforcerDid: node.nodeDid, spaceId: review.account.spaceId,
      resource: { kind: "exact" }, storage: { path }, encryptionNetwork: networkId, encryptionKeyPath: keyPath,
      mediaType: MEDIA_TYPE, byteLength, expiresAt: new Date(review.expiresAt) });
    check();
    stage = "requesting exact-key consent";
    const consent = await tcw.requestPermissions([{ service: "tinycloud.encryption", path: `${networkId}/${keyPath}`,
      actions: ["tinycloud.encryption/key.create"] }], { expiryMs: review.expiresAt - now() });
    check();
    if (!consent.approved) return { status: "declined" };
    stage = "creating the exact named-key";
    const created = await keys.createKey(keyPath, { networkId });
    check();
    if (created.networkId !== networkId || created.keyPath !== keyPath || created.state !== "active") throw new TranscriptShareError("The named-key creation receipt does not match this share.");
    stage = "encrypting the immutable transcript";
    const plaintext = new TextEncoder().encode(snapshot.text);
    const encrypted = await (async () => {
      try { return await keys.encrypt(keyPath, plaintext, { networkId, metadata: { contentType: MEDIA_TYPE } }); }
      finally { plaintext.fill(0); }
    })();
    check();
    if (encrypted.v !== 2 || encrypted.networkId !== networkId || encrypted.keyPath !== keyPath
      || encrypted.keyVersion !== created.keyVersion) throw new TranscriptShareError("The named-key envelope path, network or version does not match this share.");
    // Serialize once; the exact byte object uploaded below is the registered pin.
    const bytes = new TextEncoder().encode(canonicalize(encrypted));
    const contentSource = {
      shareId: review.shareId, kvResource: `${review.account.spaceId}/kv/${path}`, selector: "exact" as const,
      encryptionNetwork: networkId, encryptionKeyPath: keyPath, keyVersion: encrypted.keyVersion,
      encryptedSymmetricKeyDigestHex: rawWrappedKeyDigest(encrypted.encryptedSymmetricKey),
      mode: "immutable" as const, initialCiphertextDigestHex: bytesToHex(sha256(bytes)),
    };
    const putImmutable = async (key: string, value: Uint8Array) => {
      const result = await runOnSpace(review.account.spaceId, () => {
        check();
        return tcw.kv.put(key, value, { prefix: "", contentType: "application/vnd.tinycloud.encrypted-envelope+json", ifNoneMatch: "*" });
      });
      check();
      if (!result.ok) throw new TranscriptShareError("The immutable snapshot/owner receipt write was refused.");
    };
    stage = "storing the immutable transcript";
    await putImmutable(path, bytes);
    const authority: AddressedPublishAuthority = {
      ownerDid: review.account.holderDid,
      createOwnerRoot: async (root) => { check(); const result = await tcw.createUnifiedOwnerRoot(root); check(); return result; },
      sign: async (value) => { check(); const signature = await tcw.signSessionBytes(value); check(); return signature; },
      registerPolicy: async (policy) => { check(); const receipt = await tcw.registerPolicy(policy); check(); return receipt; },
    };
    stage = "publishing the exact-recipient policy";
    let deliveryMaterial: PublishedShareDeliveryMaterial | undefined;
    const published = await operations.publish({
      ...request, ...prepared, shareId: review.shareId, apiOrigin: input.origins.apiOrigin, shareOrigin: input.origins.shareOrigin,
      nodeOrigin: node.origin, nodeAudience: node.nodeDid, enforcerDid: node.nodeDid, spaceId: review.account.spaceId,
      resource: { kind: "exact", path }, contentSource, mediaType: MEDIA_TYPE,
      byteLength, expiresAt: new Date(review.expiresAt), authority,
      onDeliveryMaterial: (material) => { deliveryMaterial = material; },
    });
    check();
    // SDK history preserves both revocation roots and non-enumerable link/delivery material.
    const material = published.deliveryMaterial ?? deliveryMaterial;
    const record = { ...historyRecordForPublishedShare(published), ...(material ? { deliveryMaterial: material } : {}) };
    stage = "saving the encrypted owner revocation receipt";
    const receiptPlaintext = new TextEncoder().encode(canonicalize(record));
    const receiptEnvelope = await (async () => {
      try { return await keys.encrypt(keyPath, receiptPlaintext, { networkId, metadata: { contentType: "application/json" } }); }
      finally { receiptPlaintext.fill(0); }
    })();
    check();
    if (receiptEnvelope.v !== 2 || receiptEnvelope.networkId !== networkId || receiptEnvelope.keyPath !== keyPath
      || receiptEnvelope.keyVersion !== created.keyVersion) throw new TranscriptShareError("The named-key owner receipt does not match this share.");
    const receiptPath = `${SNAPSHOTS_PREFIX}/${review.shareId}/owner-receipt.enc.json`;
    await putImmutable(receiptPath, new TextEncoder().encode(canonicalize(receiptEnvelope)));
    return { status: "published", published, receiptPath };
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (stage === "requesting exact-key consent" && code === "USER_CANCELLED") {
      check();
      return { status: "declined" };
    }
    const suffix = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,60}$/.test(code) ? ` (${code})` : "";
    // Do not render an SDK/transport Error.message: it can contain a signed URL or secret body.
    if (error instanceof TranscriptShareError) throw error;
    throw new Error(`Transcript sharing stopped while ${stage}${suffix}. No link was returned.`, { cause: error });
  }
}
