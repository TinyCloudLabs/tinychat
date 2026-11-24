import { expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { backendStandingMetadataStore } from "../trustbot-reads/standing-store.js";

const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const other = `did:pkh:eip155:1:0x${"cd".repeat(20)}`;

// Stores text and reads it back as the TinyCloud client does: JSON comes back parsed unless the read asks for raw.
function clientLikeKv() {
  const values = new Map<string, { text: string; etag: string }>();
  let revision = 0;
  const node = {
    kv: {
      async get(key: string, options?: { raw?: boolean }) {
        const stored = values.get(key);
        if (!stored) return { ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } };
        const data = options?.raw ? stored.text : JSON.parse(stored.text);
        return { ok: true, data: { data, headers: { etag: stored.etag, contentLength: stored.text.length } } };
      },
      async put(key: string, text: string, condition: { ifMatch?: string; ifNoneMatch?: string }) {
        const current = values.get(key);
        if ((condition.ifNoneMatch && current) || (condition.ifMatch && current?.etag !== condition.ifMatch)) {
          return { ok: false, error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "precondition failed", meta: { status: 412 } } };
        }
        values.set(key, { text, etag: `"blake3-${++revision}"` });
        return { ok: true };
      },
    },
  } as unknown as TinyCloudNode;
  return node;
}

test("approval metadata written by the store reads back with its version from a client that parses JSON", async () => {
  const store = backendStandingMetadataStore(clientLikeKv());
  expect(await store.read(owner)).toEqual({ state: { generation: 0 } });

  expect(await store.write(owner, { generation: 1, outcome: "declined" }, undefined)).toBe(true);
  const first = await store.read(owner);
  expect(first).toEqual({ state: { generation: 1, outcome: "declined" }, version: "\"blake3-1\"" });

  expect(await store.write(owner, { generation: 2 }, first.version)).toBe(true);
  expect(await store.write(owner, { generation: 3 }, first.version)).toBe(false);
  expect(await store.read(owner)).toEqual({ state: { generation: 2 }, version: "\"blake3-2\"" });
  expect(await store.read(other)).toEqual({ state: { generation: 0 } });
});
