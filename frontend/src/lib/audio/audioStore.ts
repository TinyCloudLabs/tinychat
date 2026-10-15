// Audio storage in the user's own TinyCloud space: the one implementation of
// the chunked layout, used by uploaded meeting audio (TC-593) and voice notes
// (TC-517).
//
// A file is stored as raw-byte parts plus a JSON manifest under one base key:
//
//   ${APP_ID}/connectors/${source}/audio/${id}/p/000000   (application/octet-stream)
//   ${APP_ID}/connectors/${source}/audio/${id}/p/000001
//   ...
//   ${APP_ID}/connectors/${source}/audio/${id}/manifest   (application/json)
//
// The manifest is written LAST, so a manifest means a complete upload; readers
// never see a half-stored file. Every storage call is sequential: TinyCloud
// drops concurrent responses on one space.
//
// Resume lists candidate keys, then reads and hashes each listed part before
// trusting it. A listed key alone is not evidence that the bytes are current.
//
// Parts are at most MAX_AUDIO_PART_SIZE because the SDK sends a part as the
// raw request body, and a browser sees an oversized body only as "Failed to fetch".

import type { Result, ServiceError } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { audioHasher, hashAudioBytes } from "./audioHash";

import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";

/** The `tcw.kv` handle the app already uses. */
export type TinyCloudKv = TinyCloudWeb["kv"];

export interface StoredAudioPart {
  size: number;
  /** SHA-256 of the bytes at this part's key. Older manifests have no digest. */
  sha256?: string;
  /** The node's ETag from the put; null for a part kept from an interrupted attempt. */
  etag: string | null;
}

export interface StoredAudioManifest {
  v: 1;
  mimeType: string;
  fileName: string;
  size: number;
  partSize: number;
  parts: StoredAudioPart[];
  sha256: string | null;
  createdAt: string;
}

export interface VerifiedAudioReceipt { sha256: string; size: number }

async function digest(bytes: Blob | Uint8Array): Promise<string> {
  return hashAudioBytes(bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes);
}

/** A content identity for a manifest whose parts all carry hashes. */
export async function manifestReceipt(manifest: StoredAudioManifest): Promise<VerifiedAudioReceipt | null> {
  if (manifest.parts.some((part) => !part.sha256 || !/^[0-9a-f]{64}$/.test(part.sha256))
    || !manifest.sha256 || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return null;
  return { sha256: manifest.sha256, size: manifest.size };
}

/** Check the manifest returned by a separate space read against the local upload. */
export async function verifiedManifestReceipt(
  kv: TinyCloudKv, base: string, local: StoredAudioManifest, opts: RetryOptions = {},
): Promise<VerifiedAudioReceipt> {
  const remote = await getAudioManifest(kv, base, opts);
  const expected = await manifestReceipt(local);
  const actual = remote && await manifestReceipt(remote);
  if (!expected || !actual || actual.size !== expected.size || actual.sha256 !== expected.sha256
    || remote!.parts.length !== local.parts.length
    || remote!.parts.some((part, index) => part.size !== local.parts[index]!.size || part.sha256 !== local.parts[index]!.sha256)) {
    throw new AudioStoreError(AUDIO_CORRUPT, `audioStore manifest at ${base} does not match local audio`);
  }
  // A manifest alone cannot prove the part keys still contain those bytes.
  // Read each committed part before authorizing a local cache eviction.
  const fileHash = await audioHasher();
  for (let index = 0; index < remote!.parts.length; index++) {
    const part = remote!.parts[index]!;
    const key = audioPartKey(base, index);
    const result = await withRetry((signal) => kv.get<Uint8Array<ArrayBuffer>>(key,
      { binary: true, maxResponseBytes: part.size, signal: signal ?? opts.signal }), opts, `KV get ${key}`);
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "KV_RESPONSE_TOO_LARGE")
        throw new AudioStoreError(AUDIO_CORRUPT, `audioStore part ${index} does not match local audio`);
      throw kvError(`verify part ${index}`, result.error);
    }
    const bytes = result.data.data;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== part.size || await digest(bytes) !== part.sha256)
      throw new AudioStoreError(AUDIO_CORRUPT, `audioStore part ${index} does not match local audio`);
    await fileHash.update(bytes);
  }
  if (await fileHash.digest() !== expected.sha256)
    throw new AudioStoreError(AUDIO_CORRUPT, `audioStore file at ${base} does not match local audio`);
  return expected;
}

/** Upgrade an older space manifest only when every stored byte matches the local recording. */
export async function reconcileAudioReceipt(
  kv: TinyCloudKv, base: string, source: AudioPartSource, opts: RetryOptions = {},
): Promise<VerifiedAudioReceipt | null> {
  const manifest = await getAudioManifest(kv, base, opts);
  if (!manifest || manifest.size !== source.size) return null;
  const fileHash = await audioHasher();
  const parts: StoredAudioPart[] = [];
  let offset = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const entry = manifest.parts[index]!;
    const key = audioPartKey(base, index);
    const local = await source.readPart(offset, entry.size);
    const localBytes = local instanceof Blob ? new Uint8Array(await local.arrayBuffer()) : local;
    if (localBytes.byteLength !== entry.size) return null;
    const result = await withRetry((signal) => kv.get<Uint8Array<ArrayBuffer>>(key,
      { binary: true, maxResponseBytes: entry.size, signal: signal ?? opts.signal }), opts, `KV get ${key}`);
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "KV_RESPONSE_TOO_LARGE") return null;
      throw kvError(`reconcile part ${index}`, result.error);
    }
    const remote = result.data.data;
    if (remote instanceof Uint8Array) opts.onBytesRead?.(remote.byteLength);
    const partHash = await digest(localBytes);
    if (!(remote instanceof Uint8Array) || remote.byteLength !== entry.size
      || await digest(remote) !== partHash || (entry.sha256 && entry.sha256 !== partHash)) return null;
    await fileHash.update(localBytes);
    parts.push({ ...entry, sha256: partHash });
    offset += entry.size;
  }
  if (offset !== source.size) return null;
  const hash = await fileHash.digest();
  if (manifest.sha256 && manifest.sha256 !== hash) return null;
  const upgraded = { ...manifest, parts, sha256: hash };
  if (!manifest.sha256 || manifest.parts.some((part) => !part.sha256)) {
    const written = await withRetry((signal) => kv.put(audioManifestKey(base), JSON.stringify(upgraded),
      { contentType: "application/json", signal: signal ?? opts.signal }), opts, `KV put ${audioManifestKey(base)}`);
    if (!written.ok) throw kvError("upgrade manifest", written.error);
  }
  // The loop above has already read every remote part, checked it against the
  // local bytes and the manifest, and built the complete file hash. A second
  // verification pass would download the whole recording again.
  return { sha256: hash, size: source.size };
}

/**
 * The audio to store, read one part at a time just before that part is sent,
 * so the whole file never has to sit in memory. `readPart` must resolve exactly
 * `length` bytes. {@link blobPartSource} adapts a Blob or File; on the phone the
 * native recorder's readAudioChunk bridge is another source.
 */
export interface AudioPartSource {
  size: number;
  readPart(offset: number, length: number): Promise<Blob | Uint8Array>;
}

export function blobPartSource(blob: Blob): AudioPartSource {
  return { size: blob.size, readPart: async (offset, length) => blob.slice(offset, offset + length) };
}

/** `code` of an {@link AudioStoreError} that is not a KV error code. */
export const AUDIO_STORAGE_FULL = "STORAGE_QUOTA_EXCEEDED";
export const AUDIO_SOURCE_READ_FAILED = "AUDIO_SOURCE_READ_FAILED";
export const AUDIO_TOO_LARGE = "AUDIO_TOO_LARGE";
export const AUDIO_CORRUPT = "STORE_CORRUPT_AUDIO";
/** `code` of an upload the node refused as over its body limit (a plain HTTP 413, not a full space). */
export const AUDIO_UPLOAD_TOO_LARGE = "UPLOAD_TOO_LARGE";
/** `code` of a plain HTTP 402 that is not a storage rejection. */
export const AUDIO_PAYMENT_REQUIRED = "PAYMENT_REQUIRED";

/**
 * A storage failure. `code` is one of the AUDIO_* codes above or the SDK's KV
 * error code (e.g. KV_NOT_FOUND, AUTH_UNAUTHORIZED, NETWORK_ERROR).
 */
export class AudioStoreError extends Error {
  readonly code: string;
  readonly sizeBytes?: number;

  constructor(code: string, message: string, options?: ErrorOptions, sizeBytes?: number) {
    super(message, options);
    this.name = "AudioStoreError";
    this.code = code;
    this.sizeBytes = sizeBytes;
  }
}

/** Storage quota reached: the node's explicit STORAGE_QUOTA_EXCEEDED or STORAGE_LIMIT_REACHED. No manifest was written. */
export class AudioStoreQuotaError extends AudioStoreError {
  constructor(message: string, options?: ErrorOptions) {
    super(AUDIO_STORAGE_FULL, message, options);
    this.name = "AudioStoreQuotaError";
  }
}

interface RetryOptions {
  signal?: AbortSignal;
  onBytesRead?: (bytes: number) => void;
  schedule?: <T>(call: (signal?: AbortSignal) => Promise<T>, operation?: string, timeoutMs?: number,
    payloadBytes?: number) => Promise<T>;
  /** Waits before each retry of a transient failure; its length bounds the retries. Tests pass zeros. */
  retryDelaysMs?: readonly number[];
  onRetry?: (attempt: number, code: string) => void;
}

export interface PutAudioOptions extends RetryOptions {
  fileName: string;
  mimeType: string;
  sha256?: string | null;
  /** Bytes per stored part, at most (and by default) {@link MAX_AUDIO_PART_SIZE}. */
  partSize?: number;
  /** Called after resumable-part discovery and before the first audio transfer. */
  onUploadStart?: (totalBytes: number) => void;
  onProgress?: (storedBytes: number, totalBytes: number) => void;
}

export interface GetAudioOptions extends RetryOptions {
  /** Refuse (AUDIO_TOO_LARGE) a file larger than this, from its manifest, before reading any part. */
  maxBytes?: number;
  onProgress?: (loadedBytes: number, totalBytes: number) => void;
}

/**
 * The largest request body the production TinyCloud node accepts: nginx/1.27.4
 * in front of tee.node.tinycloud.xyz caps bodies at 1 MiB (1,048,577 bytes get
 * a CORS-less 413). Raise this together with that ingress limit.
 */
export const MAX_AUDIO_PART_SIZE = 1024 * 1024;

const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * `${APP_ID}/connectors/${source}/audio/${id}` — chunks at `${base}/p/${000000}`,
 * manifest at `${base}/manifest`.
 */
export function audioBaseKey(source: string, id: string): string {
  if (!source || source.includes("/") || !id || id.includes("/")) {
    throw new Error("audioBaseKey: source and id must be non-empty path segments");
  }
  return `${CONNECTORS_KV_PREFIX}/${source}/audio/${id}`;
}

export function audioPartKey(base: string, index: number): string {
  return `${base}/p/${String(index).padStart(6, "0")}`;
}

export function audioManifestKey(base: string): string {
  return `${base}/manifest`;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function status(error: ServiceError): number | undefined {
  const value = (error.meta as { status?: unknown } | undefined)?.status;
  return typeof value === "number" ? value : undefined;
}

function isTransient(error: ServiceError): boolean {
  if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") return true;
  const code = status(error);
  return code !== undefined && (code >= 500 || code === 408 || code === 429);
}

// Quota evidence, @tinycloud/sdk-services 3.2.1 (node_modules/.bun/@tinycloud+sdk-services@3.2.1+*/node_modules/@tinycloud/sdk-services/dist/kv/index.js):
// - put 402: always STORAGE_QUOTA_EXCEEDED, whatever the body (storageRejectionError L383-386; handleQuotaErrorResponse L903-916; put L1593).
// - put 413 with a storage body (JSON error storage_quota_exceeded/storage_limit_reached, or "Used: N bytes, Limit: M bytes"):
//   STORAGE_LIMIT_REACHED (parseStorageRejection L360-382).
// - put 413 with any other body: no quota; SDK returns KV_WRITE_FAILED with meta.status 413 (L903-908, L1596).
// - get 413: KV_RESPONSE_TOO_LARGE (L1232, L1493).
// No status-only quota response was found in the SDK, the repo's backend, or the frontend.
// So quota is recognised ONLY by the explicit codes. A plain 413 or 402 keeps its status under its own code.
function kvError(op: string, error: ServiceError): AudioStoreError {
  if (error.code === "KV_RESPONSE_TOO_LARGE") {
    return new AudioStoreError(AUDIO_CORRUPT, `audioStore ${op}: stored part is larger than its manifest`, { cause: error });
  }
  if (error.code === "STORAGE_QUOTA_EXCEEDED" || error.code === "STORAGE_LIMIT_REACHED") {
    return new AudioStoreQuotaError(`audioStore ${op}: storage quota reached`, { cause: error });
  }
  if (status(error) === 413) {
    return new AudioStoreError(AUDIO_UPLOAD_TOO_LARGE, `audioStore ${op}: the node refused the request as too large`, { cause: error });
  }
  if (status(error) === 402) {
    return new AudioStoreError(AUDIO_PAYMENT_REQUIRED, `audioStore ${op}: the node refused the request for payment`, { cause: error });
  }
  return new AudioStoreError(error.code ?? "STORE_ERROR", `audioStore ${op} failed: ${error.code}: ${error.message}`, { cause: error });
}

/** Promise.withResolvers is ES2024; the frontend compiles against the ES2022 lib. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs one KV call, retrying transient failures (network, timeout, 5xx/408/429)
 * with bounded backoff. An aborted call throws AbortError; any other failure is
 * returned for the caller to classify.
 */
async function withRetry<T>(call: (signal?: AbortSignal) => Promise<Result<T>>, opts: RetryOptions, operation = "audio KV request",
  payloadBytes = 0): Promise<Result<T>> {
  const { signal } = opts;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const res = await (opts.schedule ? opts.schedule(call, operation, undefined, payloadBytes) : call(signal));
    if (!res.ok && (res.error.code === "ABORTED" || signal?.aborted)) throw abortError();
    if (res.ok || attempt >= delays.length || !isTransient(res.error)) return res;
    opts.onRetry?.(attempt + 1, res.error.code ?? "STORE_ERROR");
    await sleep(delays[attempt]!, signal);
  }
}

/** Every key under `prefix`, following list continuation cursors. */
async function listKeys(kv: TinyCloudKv, prefix: string, opts: RetryOptions): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await withRetry(
      (deadlineSignal) => kv.list({ path: prefix, ...(cursor === undefined ? {} : { cursor }), signal: deadlineSignal ?? opts.signal }),
      opts, `KV list ${prefix}`,
    );
    if (!page.ok) throw kvError(`list ${prefix}`, page.error);
    for (const key of page.data.keys) {
      if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
    }
    const next = page.data.nextCursor;
    if (!page.data.truncated || !next) return keys;
    if (seen.has(next)) throw new AudioStoreError(AUDIO_CORRUPT, `audioStore list ${prefix} failed: repeated cursor`);
    seen.add(next);
    cursor = next;
  }
}

/**
 * Store `source` under `base` as sequential raw-byte parts, then the manifest.
 * Each part is read from `source` just before it is sent.
 *
 * Resume: call again with the SAME audio, base and partSize after an interrupted
 * attempt (abort, network loss, closed tab, failed save). Parts whose keys
 * already exist are read back and checked against the local bytes. A stale or
 * truncated key is overwritten before the manifest can be published.
 *
 * Rejects with AudioStoreQuotaError when the space is out of storage, an
 * AudioStoreError (AUDIO_SOURCE_READ_FAILED when `source` fails or reads short;
 * otherwise the KV code) for any other failure that outlasted the retries, a
 * RangeError for an invalid size or partSize, and an AbortError DOMException when
 * `signal` aborts. In every rejection no manifest is written.
 */
export async function putAudio(
  kv: TinyCloudKv,
  base: string,
  source: AudioPartSource,
  opts: PutAudioOptions,
): Promise<StoredAudioManifest> {
  const partSize = opts.partSize ?? MAX_AUDIO_PART_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > MAX_AUDIO_PART_SIZE) {
    throw new RangeError(`putAudio: partSize must be an integer from 1 to ${MAX_AUDIO_PART_SIZE}`);
  }
  const total = source.size;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError("putAudio: the audio's size is unknown");
  }

  const existing = new Set(await listKeys(kv, `${base}/p/`, opts));
  opts.onUploadStart?.(total);

  const parts: StoredAudioPart[] = [];
  const fileHash = await audioHasher();
  let stored = 0;
  for (let index = 0, offset = 0; offset < total; index++, offset += partSize) {
    const key = audioPartKey(base, index);
    const length = Math.min(partSize, total - offset);
    let etag: string | null = null;
    {
      let part: Blob | Uint8Array;
      try {
        part = await source.readPart(offset, length);
      } catch (err) {
        throw new AudioStoreError(
          AUDIO_SOURCE_READ_FAILED,
          `audioStore read part ${index}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      const got = part instanceof Blob ? part.size : part.byteLength;
      if (got !== length) {
        throw new AudioStoreError(AUDIO_SOURCE_READ_FAILED, `audioStore read part ${index}: got ${got} of ${length} bytes`);
      }
      const sha256 = await digest(part);
      await fileHash.update(part instanceof Blob ? new Uint8Array(await part.arrayBuffer()) : part);
      let valid = false;
      if (existing.has(key)) {
        const prior = await withRetry((deadlineSignal) => kv.get<Uint8Array<ArrayBuffer>>(key, {
          binary: true, maxResponseBytes: length, signal: deadlineSignal ?? opts.signal,
        }), opts, `KV get ${key}`);
        if (!prior.ok && prior.error.code !== "KV_NOT_FOUND" && prior.error.code !== "KV_RESPONSE_TOO_LARGE") {
          throw kvError(`validate part ${index}`, prior.error);
        }
        valid = prior.ok && prior.data.data instanceof Uint8Array
          && prior.data.data.byteLength === length && await digest(prior.data.data) === sha256;
      }
      if (!valid) {
        const res = await withRetry(
        (deadlineSignal) => kv.put(key, part, { contentType: "application/octet-stream", signal: deadlineSignal ?? opts.signal }),
        opts, `KV put ${key}`, length,
        );
        if (!res.ok) throw kvError(`put part ${index}`, res.error);
        etag = res.data?.headers?.etag ?? null;
      }
      parts.push({ size: length, sha256, etag });
    }
    stored += length;
    opts.onProgress?.(stored, total);
  }

  const manifest: StoredAudioManifest = {
    v: 1,
    mimeType: opts.mimeType,
    fileName: opts.fileName,
    size: total,
    partSize,
    parts,
    sha256: await fileHash.digest(),
    createdAt: new Date().toISOString(),
  };
  if (opts.sha256 && opts.sha256 !== manifest.sha256) {
    throw new AudioStoreError(AUDIO_SOURCE_READ_FAILED, "audioStore local audio hash changed during upload");
  }
  const written = await withRetry(
    (deadlineSignal) => kv.put(audioManifestKey(base), JSON.stringify(manifest), { contentType: "application/json", signal: deadlineSignal ?? opts.signal }),
    opts, `KV put ${audioManifestKey(base)}`,
  );
  if (!written.ok) throw kvError("put manifest", written.error);
  return manifest;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A stored manifest, or null when it is not one (wrong version, sizes that do not add up). */
export function parseAudioManifest(raw: unknown): StoredAudioManifest | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (
    m.v !== 1
    || typeof m.mimeType !== "string"
    || typeof m.fileName !== "string"
    || !isNonNegativeInteger(m.size)
    || !isNonNegativeInteger(m.partSize)
    || (m.sha256 !== null && typeof m.sha256 !== "string")
    || typeof m.createdAt !== "string"
    || !Array.isArray(m.parts)
  ) {
    return null;
  }
  const parts: StoredAudioPart[] = [];
  let sum = 0;
  for (const part of m.parts as unknown[]) {
    if (!part || typeof part !== "object") return null;
    const { size, etag, sha256 } = part as Record<string, unknown>;
    if (!isNonNegativeInteger(size) || (etag !== null && typeof etag !== "string")) return null;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256))) return null;
    parts.push({ size, etag, ...(sha256 === undefined ? {} : { sha256 }) });
    sum += size;
  }
  if (sum !== m.size) return null;
  return {
    v: 1,
    mimeType: m.mimeType,
    fileName: m.fileName,
    size: m.size,
    partSize: m.partSize,
    parts,
    sha256: m.sha256,
    createdAt: m.createdAt,
  };
}

/**
 * The manifest of a completely stored file, or null when none is stored under
 * `base`. A failed read rejects with its KV code; a malformed manifest with AUDIO_CORRUPT.
 */
export async function getAudioManifest(
  kv: TinyCloudKv,
  base: string,
  opts: RetryOptions = {},
): Promise<StoredAudioManifest | null> {
  const res = await withRetry((deadlineSignal) => kv.get(audioManifestKey(base), { signal: deadlineSignal ?? opts.signal }), opts,
    `KV get ${audioManifestKey(base)}`);
  if (!res.ok) {
    if (res.error.code === "KV_NOT_FOUND") return null;
    throw kvError("get manifest", res.error);
  }
  const manifest = parseAudioManifest(res.data.data);
  if (!manifest) throw new AudioStoreError(AUDIO_CORRUPT, `audioStore manifest at ${base} is malformed`);
  return manifest;
}

/**
 * Reassemble the stored file as a Blob typed with the manifest's mimeType, or
 * null when no complete file is stored under `base`. Rejects with AUDIO_CORRUPT
 * when a part's length disagrees with the manifest, so a mismatched resume can
 * never play back as the wrong audio, and with AUDIO_TOO_LARGE (before reading
 * any part) for a file over `maxBytes`.
 */
export async function getAudio(
  kv: TinyCloudKv,
  base: string,
  opts: GetAudioOptions = {},
): Promise<Blob | null> {
  const { signal, onProgress, maxBytes } = opts;
  if (signal?.aborted) throw abortError();
  const manifest = await getAudioManifest(kv, base, opts);
  if (!manifest) return null;
  if (maxBytes !== undefined && manifest.size > maxBytes) {
    throw new AudioStoreError(AUDIO_TOO_LARGE, `audioStore: the audio is ${manifest.size} bytes, over ${maxBytes}`, undefined, manifest.size);
  }
  const chunks: Blob[] = [];
  const fileHash = manifest.sha256 ? await audioHasher() : null;
  let loaded = 0;
  for (let index = 0; index < manifest.parts.length; index++) {
    const expected = manifest.parts[index]!.size;
    const key = audioPartKey(base, index);
    const res = await withRetry(
      // The SDK's binary read is `new Uint8Array(await response.arrayBuffer())`.
      (deadlineSignal) => kv.get<Uint8Array<ArrayBuffer>>(key, {
        binary: true,
        ...(deadlineSignal || signal ? { signal: deadlineSignal ?? signal } : {}),
        // Refuse an oversized part at the node instead of downloading it.
        ...(expected > 0 ? { maxResponseBytes: expected } : {}),
      }),
      opts, `KV get ${key}`,
    );
    if (!res.ok) throw kvError(`get part ${index}`, res.error);
    const bytes = res.data.data;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) {
      throw new AudioStoreError(AUDIO_CORRUPT, `audioStore part ${index} does not match its manifest`);
    }
    if (manifest.parts[index]!.sha256 && await digest(bytes) !== manifest.parts[index]!.sha256) {
      throw new AudioStoreError(AUDIO_CORRUPT, `audioStore part ${index} hash does not match its manifest`);
    }
    await fileHash?.update(bytes);
    // One Blob per part lets the browser hold the bytes outside the JS heap.
    chunks.push(new Blob([bytes]));
    loaded += expected;
    onProgress?.(loaded, manifest.size);
  }
  if (fileHash && await fileHash.digest() !== manifest.sha256) {
    throw new AudioStoreError(AUDIO_CORRUPT, "audioStore file hash does not match its manifest");
  }
  return new Blob(chunks, { type: manifest.mimeType });
}

/**
 * Remove every key under `base`. The manifest goes first so readers see the
 * file gone before its parts are removed; a retry after a partial failure
 * finishes the job.
 */
export async function deleteAudio(kv: TinyCloudKv, base: string): Promise<void> {
  const manifest = await withRetry(() => kv.delete(audioManifestKey(base)), {});
  if (!manifest.ok && manifest.error.code !== "KV_NOT_FOUND") throw kvError("delete manifest", manifest.error);
  for (const key of await listKeys(kv, `${base}/`, {})) {
    const res = await withRetry(() => kv.delete(key), {});
    if (!res.ok && res.error.code !== "KV_NOT_FOUND") throw kvError(`delete ${key}`, res.error);
  }
}
