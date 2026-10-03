import { describe, expect, test } from "bun:test";

import {
  AudioStoreQuotaError,
  type TinyCloudKv,
  audioBaseKey,
  deleteAudio,
  getAudio,
  getAudioManifest,
  putAudio,
} from "./audioStore";

interface KvErr {
  code: string;
  message: string;
  service: string;
  meta?: Record<string, unknown>;
}

/** In-memory stand-in for `tcw.kv` with the SDK's Result shapes. */
class FakeKv {
  entries = new Map<string, { bytes: Uint8Array; contentType: string }>();
  puts: string[] = [];
  deletes: string[] = [];
  /** Returned (once) by the put of the key it names. */
  putFailures = new Map<string, KvErr>();

  async put(key: string, value: unknown, options?: { contentType?: string }) {
    const failure = this.putFailures.get(key);
    if (failure) {
      this.putFailures.delete(key);
      return { ok: false as const, error: failure };
    }
    const bytes = value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : new TextEncoder().encode(String(value));
    this.entries.set(key, { bytes, contentType: options?.contentType ?? "text/plain" });
    this.puts.push(key);
    return { ok: true as const, data: { data: undefined, headers: { etag: `"etag-${key}"` } } };
  }

  async get(key: string, options?: { binary?: boolean; maxResponseBytes?: number }) {
    const entry = this.entries.get(key);
    if (!entry) return { ok: false as const, error: { code: "KV_NOT_FOUND", message: key, service: "kv" } };
    if (options?.maxResponseBytes !== undefined && entry.bytes.byteLength > options.maxResponseBytes) {
      return { ok: false as const, error: { code: "KV_RESPONSE_TOO_LARGE", message: key, service: "kv", meta: { status: 413 } } };
    }
    const data = options?.binary
      ? entry.bytes
      : entry.contentType === "application/json"
        ? JSON.parse(new TextDecoder().decode(entry.bytes))
        : new TextDecoder().decode(entry.bytes);
    return { ok: true as const, data: { data, headers: {} } };
  }

  async list(options: { path: string }) {
    const keys = [...this.entries.keys()].filter((key) => key.startsWith(options.path)).sort();
    return { ok: true as const, data: { keys, truncated: false } };
  }

  async delete(key: string) {
    this.deletes.push(key);
    if (!this.entries.delete(key)) {
      return { ok: false as const, error: { code: "KV_NOT_FOUND", message: key, service: "kv" } };
    }
    return { ok: true as const, data: { data: undefined, headers: {} } };
  }

  get kv(): TinyCloudKv {
    return this as unknown as TinyCloudKv;
  }
}

const BASE = audioBaseKey("exo-upload", "meeting-1");
const OPTS = { fileName: "call.m4a", mimeType: "audio/mp4", partSize: 4 };

function audioBlob(): Blob {
  return new Blob([Uint8Array.from({ length: 10 }, (_, i) => i + 1)], { type: "audio/mp4" });
}

async function bytesOf(blob: Blob): Promise<number[]> {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

describe("audioStore", () => {
  test("a quota failure rejects with AudioStoreQuotaError and writes no manifest", async () => {
    // The SDK maps node 402 → STORAGE_QUOTA_EXCEEDED and put-413 → STORAGE_LIMIT_REACHED.
    for (const [code, status] of [["STORAGE_QUOTA_EXCEEDED", 402], ["STORAGE_LIMIT_REACHED", 413]] as const) {
      const fake = new FakeKv();
      fake.putFailures.set(`${BASE}/p/000001`, {
        code,
        message: "Storage quota exceeded: Used: 104857600 bytes, Limit: 104857600 bytes",
        service: "kv",
        meta: { status, usedBytes: 104857600, limitBytes: 104857600 },
      });

      const result = putAudio(fake.kv, BASE, audioBlob(), OPTS);

      await expect(result).rejects.toBeInstanceOf(AudioStoreQuotaError);
      expect(fake.entries.has(`${BASE}/manifest`)).toBe(false);
      expect(await getAudioManifest(fake.kv, BASE)).toBeNull();
    }
  });

  test("an interrupted upload resumes without re-sending stored parts and reads back byte-identical", async () => {
    const fake = new FakeKv();
    const controller = new AbortController();
    const first = putAudio(fake.kv, BASE, audioBlob(), {
      ...OPTS,
      signal: controller.signal,
      onProgress: (stored) => {
        if (stored === 4) controller.abort();
      },
    });
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(await getAudioManifest(fake.kv, BASE)).toBeNull();

    fake.puts = [];
    const progress: number[] = [];
    const manifest = await putAudio(fake.kv, BASE, audioBlob(), {
      ...OPTS,
      onProgress: (stored, total) => progress.push(stored / total),
    });

    expect(fake.puts).toEqual([`${BASE}/p/000001`, `${BASE}/p/000002`, `${BASE}/manifest`]);
    expect(progress).toEqual([0.4, 0.8, 1]);
    expect(manifest.parts).toEqual([
      { size: 4, etag: null },
      { size: 4, etag: `"etag-${BASE}/p/000001"` },
      { size: 2, etag: `"etag-${BASE}/p/000002"` },
    ]);
    const blob = await getAudio(fake.kv, BASE);
    expect(blob?.type).toBe("audio/mp4");
    expect(await bytesOf(blob!)).toEqual(await bytesOf(audioBlob()));
  });

  test("getAudio refuses a part whose size disagrees with the manifest", async () => {
    const fake = new FakeKv();
    await putAudio(fake.kv, BASE, audioBlob(), OPTS);
    // A part left by an attempt with a different partSize.
    fake.entries.set(`${BASE}/p/000002`, { bytes: new Uint8Array(1), contentType: "application/octet-stream" });

    await expect(getAudio(fake.kv, BASE)).rejects.toThrow("does not match its manifest");
  });

  test("deleteAudio removes the manifest first, then every key under the base", async () => {
    const fake = new FakeKv();
    const other = audioBaseKey("exo-upload", "meeting-10");
    await putAudio(fake.kv, BASE, audioBlob(), OPTS);
    await putAudio(fake.kv, other, audioBlob(), OPTS);

    await deleteAudio(fake.kv, BASE);

    expect(fake.deletes[0]).toBe(`${BASE}/manifest`);
    expect([...fake.entries.keys()].filter((key) => key.startsWith(`${BASE}/`))).toEqual([]);
    expect(await getAudio(fake.kv, BASE)).toBeNull();
    expect(await getAudioManifest(fake.kv, other)).not.toBeNull();
  });
});
