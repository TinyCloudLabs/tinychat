import { createHash } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";

/**
 * TC-2917: the backend's TinyCloud KV as the production node serves it. Each read and write carries
 * a strong CONTENT-hash ETag (`"blake3-<64 hex>"`): identical bytes have the same ETag, so a value
 * written back unchanged is indistinguishable from one never changed. put honours If-Match and
 * If-None-Match, and delete honours If-Match, answering 412 as the SDK does (KV_PRECONDITION_FAILED).
 * `values` is the stored data: setting or deleting a key there is a write by another writer, and its
 * ETag follows from its content. Test files share this fake so none drifts from the real node.
 */
export type FakeKvOp = "get" | "put" | "delete" | "list";
export interface FakeBackendNodeHooks {
  /** Runs before each call (`key` is the prefix for list). A returned value is the call's answer. */
  before?(op: FakeKvOp, key: string, value?: unknown): unknown | Promise<unknown>;
  /** Runs after each call has read or changed `values`, before it answers. */
  after?(op: FakeKvOp, key: string): void | Promise<void>;
}

export const PRECONDITION_FAILED = { ok: false, error: { code: "KV_PRECONDITION_FAILED", service: "kv", message: "Precondition failed" } };
const notFound = (key: string) => ({ ok: false, error: { code: "KV_NOT_FOUND", service: "kv", message: `Key not found: ${key}` } });

/** The ETag the node sends for a stored value. */
export function contentEtag(value: unknown): string {
  return `"blake3-${createHash("sha256").update(JSON.stringify(value)).digest("hex")}"`;
}

export function fakeBackendNode(values = new Map<string, unknown>(), hooks: FakeBackendNodeHooks = {}) {
  const etagOf = (key: string) => values.has(key) ? contentEtag(values.get(key)) : undefined;
  const answer = async (op: FakeKvOp, key: string, value: unknown, act: () => unknown) => {
    const early = await hooks.before?.(op, key, value);
    if (early !== undefined) return early;
    const result = act();
    await hooks.after?.(op, key);
    return result;
  };
  const node = { kv: {
    get: (key: string) => answer("get", key, undefined, () => values.has(key)
      ? { ok: true, data: { data: structuredClone(values.get(key)), headers: { etag: etagOf(key) } } } : notFound(key)),
    put: (key: string, value: unknown, options?: { ifMatch?: string; ifNoneMatch?: "*" }) => answer("put", key, value, () => {
      if (options?.ifNoneMatch === "*" && values.has(key)) return PRECONDITION_FAILED;
      if (options?.ifMatch !== undefined && etagOf(key) !== options.ifMatch) return PRECONDITION_FAILED;
      values.set(key, structuredClone(value));
      return { ok: true, data: { headers: { etag: etagOf(key) } } };
    }),
    delete: (key: string, options?: { ifMatch?: string }) => answer("delete", key, undefined, () => {
      if (options?.ifMatch !== undefined && etagOf(key) !== options.ifMatch) return values.has(key) ? PRECONDITION_FAILED : notFound(key);
      if (!values.has(key)) return notFound(key);
      values.delete(key);
      return { ok: true, data: {} };
    }),
    list: ({ prefix }: { prefix: string }) => answer("list", prefix, undefined,
      () => ({ ok: true, data: { keys: [...values.keys()].filter(key => key.startsWith(prefix)) } })),
  } } as unknown as TinyCloudNode;
  return { node, values };
}
