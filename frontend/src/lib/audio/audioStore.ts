// Original-audio storage in the user's own TinyCloud space (TC-593).
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
// Resume uses KV list, not head. The app manifest does not grant
// `tinycloud.kv/metadata`, and a node metadata response carries no stored size
// anyway (Content-Length is not replayed). A KV put is all-or-nothing, so a
// listed part key is a fully committed part.

import type { Result, ServiceError } from "@tinycloud/sdk-core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";

/** The `tcw.kv` handle the app already uses. */
export type TinyCloudKv = TinyCloudWeb["kv"];

export interface StoredAudioPart {
  size: number;
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

/** Storage quota reached (node 402/413). No manifest was written. */
export class AudioStoreQuotaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AudioStoreQuotaError";
  }
}

export interface PutAudioOptions {
  fileName: string;
  mimeType: string;
  sha256?: string | null;
  /** Bytes per stored part. Default 8 MiB; callers may pass 4 MiB on mobile. */
  partSize?: number;
  signal?: AbortSignal;
  onProgress?: (storedBytes: number, totalBytes: number) => void;
}

export const DEFAULT_AUDIO_PART_SIZE = 8 * 1024 * 1024;

/** Waits before each retry of a transient failure; its length bounds the retries. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

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

function partKey(base: string, index: number): string {
  return `${base}/p/${String(index).padStart(6, "0")}`;
}

function manifestKey(base: string): string {
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

function isQuota(error: ServiceError): boolean {
  return error.code === "STORAGE_QUOTA_EXCEEDED"
    || error.code === "STORAGE_LIMIT_REACHED"
    || status(error) === 402
    || status(error) === 413;
}

function storeError(op: string, error: ServiceError): Error {
  return new Error(`audioStore ${op} failed: ${error.code}: ${error.message}`);
}

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
async function withRetry<T>(
  call: () => Promise<Result<T>>,
  signal?: AbortSignal,
): Promise<Result<T>> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError();
    const res = await call();
    if (!res.ok && (res.error.code === "ABORTED" || signal?.aborted)) throw abortError();
    if (res.ok || attempt >= RETRY_DELAYS_MS.length || !isTransient(res.error)) return res;
    await sleep(RETRY_DELAYS_MS[attempt], signal);
  }
}

/** Every key under `prefix`, following list continuation cursors. */
async function listKeys(kv: TinyCloudKv, prefix: string, signal?: AbortSignal): Promise<string[]> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await withRetry(
      () => kv.list({ path: prefix, ...(cursor === undefined ? {} : { cursor }), signal }),
      signal,
    );
    if (!page.ok) throw storeError(`list ${prefix}`, page.error);
    for (const key of page.data.keys) {
      if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
    }
    const next = page.data.nextCursor;
    if (!page.data.truncated || !next) return keys;
    if (seen.has(next)) throw new Error(`audioStore list ${prefix} failed: repeated cursor`);
    seen.add(next);
    cursor = next;
  }
}

/**
 * Store `blob` under `base` as sequential raw-byte parts, then the manifest.
 *
 * Resume: call again with the SAME blob, base and partSize after an interrupted
 * attempt (abort, network loss, closed tab). Parts whose keys already exist are
 * skipped — one `list` of `${base}/p/` decides, and a KV put is all-or-nothing,
 * so an existing key is a complete part. A different blob or partSize under a
 * base that already holds parts is not detected here (getAudio then refuses the
 * mismatched file), so give every file its own base.
 *
 * Rejects with AudioStoreQuotaError when the space is out of storage, with an
 * AbortError DOMException when `signal` aborts, and with an Error for any other
 * failure that outlasted the retries. In every rejection no manifest is written.
 */
export async function putAudio(
  kv: TinyCloudKv,
  base: string,
  blob: Blob,
  opts: PutAudioOptions,
): Promise<StoredAudioManifest> {
  const partSize = opts.partSize ?? DEFAULT_AUDIO_PART_SIZE;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new RangeError("putAudio: partSize must be a positive integer");
  }
  const { signal, onProgress } = opts;
  const total = blob.size;
  const partCount = Math.ceil(total / partSize);

  const existing = new Set(await listKeys(kv, `${base}/p/`, signal));

  const parts: StoredAudioPart[] = [];
  let stored = 0;
  for (let index = 0; index < partCount; index++) {
    const key = partKey(base, index);
    const chunk = blob.slice(index * partSize, Math.min(total, (index + 1) * partSize));
    let etag: string | null = null;
    if (!existing.has(key)) {
      const res = await withRetry(
        () => kv.put(key, chunk, { contentType: "application/octet-stream", signal }),
        signal,
      );
      if (!res.ok) {
        if (isQuota(res.error)) {
          throw new AudioStoreQuotaError(`Storage quota reached while storing ${key}`, { cause: res.error });
        }
        throw storeError(`put ${key}`, res.error);
      }
      etag = res.data.headers.etag ?? null;
    }
    parts.push({ size: chunk.size, etag });
    stored += chunk.size;
    onProgress?.(stored, total);
  }

  const manifest: StoredAudioManifest = {
    v: 1,
    mimeType: opts.mimeType,
    fileName: opts.fileName,
    size: total,
    partSize,
    parts,
    sha256: opts.sha256 ?? null,
    createdAt: new Date().toISOString(),
  };
  const written = await withRetry(
    () => kv.put(manifestKey(base), JSON.stringify(manifest), { contentType: "application/json", signal }),
    signal,
  );
  if (!written.ok) {
    if (isQuota(written.error)) {
      throw new AudioStoreQuotaError(`Storage quota reached while storing ${manifestKey(base)}`, { cause: written.error });
    }
    throw storeError(`put ${manifestKey(base)}`, written.error);
  }
  return manifest;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseManifest(raw: unknown): StoredAudioManifest | null {
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
    const { size, etag } = part as Record<string, unknown>;
    if (!isNonNegativeInteger(size) || (etag !== null && typeof etag !== "string")) return null;
    parts.push({ size, etag });
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
 * `base`. A failed read or a malformed manifest rejects.
 */
export async function getAudioManifest(
  kv: TinyCloudKv,
  base: string,
): Promise<StoredAudioManifest | null> {
  const res = await withRetry(() => kv.get(manifestKey(base)));
  if (!res.ok) {
    if (res.error.code === "KV_NOT_FOUND") return null;
    throw storeError(`get ${manifestKey(base)}`, res.error);
  }
  const manifest = parseManifest(res.data.data);
  if (!manifest) throw new Error(`audioStore manifest at ${base} is malformed`);
  return manifest;
}

/**
 * Reassemble the stored file as a Blob typed with the manifest's mimeType, or
 * null when no complete file is stored under `base`. Rejects when a part is
 * missing or its length disagrees with the manifest, so a mismatched resume can
 * never play back as the wrong audio.
 */
export async function getAudio(
  kv: TinyCloudKv,
  base: string,
  opts: { signal?: AbortSignal } = {},
): Promise<Blob | null> {
  const { signal } = opts;
  if (signal?.aborted) throw abortError();
  const manifest = await getAudioManifest(kv, base);
  if (!manifest) return null;
  const chunks: Blob[] = [];
  for (let index = 0; index < manifest.parts.length; index++) {
    const expected = manifest.parts[index].size;
    const key = partKey(base, index);
    const res = await withRetry(
      // The SDK's binary read is `new Uint8Array(await response.arrayBuffer())`.
      () => kv.get<Uint8Array<ArrayBuffer>>(key, {
        binary: true,
        signal,
        // Refuse an oversized part at the node instead of downloading it.
        ...(expected > 0 ? { maxResponseBytes: expected } : {}),
      }),
      signal,
    );
    if (!res.ok) throw storeError(`get ${key}`, res.error);
    const bytes = res.data.data;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) {
      throw new Error(`audioStore part ${key} does not match its manifest`);
    }
    // One Blob per part lets the browser hold the bytes outside the JS heap.
    chunks.push(new Blob([bytes]));
  }
  return new Blob(chunks, { type: manifest.mimeType });
}

/**
 * Remove every key under `base`. The manifest goes first so readers see the
 * file gone before its parts are removed; a retry after a partial failure
 * finishes the job.
 */
export async function deleteAudio(kv: TinyCloudKv, base: string): Promise<void> {
  const manifest = await withRetry(() => kv.delete(manifestKey(base)));
  if (!manifest.ok && manifest.error.code !== "KV_NOT_FOUND") {
    throw storeError(`delete ${manifestKey(base)}`, manifest.error);
  }
  for (const key of await listKeys(kv, `${base}/`)) {
    const res = await withRetry(() => kv.delete(key));
    if (!res.ok && res.error.code !== "KV_NOT_FOUND") throw storeError(`delete ${key}`, res.error);
  }
}
