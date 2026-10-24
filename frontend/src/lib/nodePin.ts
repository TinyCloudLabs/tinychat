// Change detection for a node on this computer.
//
// A local node's /info is not signed, so the saved node ID can tell that the node at an address is
// no longer the one the user confirmed; it cannot prove who is answering. The check therefore only
// ever reads: it sends `GET <address>/info` and nothing else to that address. Callers run it BEFORE
// any SDK object is built for the host (at start, on restore, before sign-in, and after the node
// has been away), never before each request.
import { isLocalNodeHost, isNodeDid, readNodePin } from "./nodeHost";

export const NODE_INFO_TIMEOUT_MS = 5_000;
export const NODE_INFO_MAX_BYTES = 16 * 1024;

export type NodeCheck =
  /** Not a local address: the hosted node is reached over TLS and is not saved. */
  | { kind: "hosted" }
  /** No answer, or an answer that is not a node /info. Fail closed: no sign-in, no fallback. */
  | { kind: "unreachable" }
  /** Something is listening but the app may not read its answer: a node started without CORS. */
  | { kind: "blocked" }
  /** No node ID saved for this address yet; the user has to confirm `nodeId` first. */
  | { kind: "first-use"; nodeId: string }
  | { kind: "match"; nodeId: string }
  | { kind: "mismatch"; savedId: string; currentId: string };

export interface NodeInfoDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

type NodeInfoRead =
  | { kind: "ok"; nodeId: string }
  /** The request went through but the answer is not a node's /info. */
  | { kind: "bad" }
  /** The request itself failed: nothing listening, a blocked cross-origin read, or too slow. */
  | { kind: "failed" };

async function readNodeInfo(address: string, deps: NodeInfoDeps): Promise<NodeInfoRead> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = deps.maxBytes ?? NODE_INFO_MAX_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? NODE_INFO_TIMEOUT_MS);
  try {
    const response = await doFetch(`${address}/info`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { kind: "bad" };
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) return { kind: "bad" };
    const text = await readCapped(response, maxBytes);
    if (text === null) return { kind: "bad" };
    const body = JSON.parse(text) as { nodeId?: unknown } | null;
    return body && typeof body === "object" && isNodeDid(body.nodeId) ? { kind: "ok", nodeId: body.nodeId } : { kind: "bad" };
  } catch (caught) {
    return caught instanceof SyntaxError ? { kind: "bad" } : { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** The `nodeId` a node reports at `<address>/info`, or null for anything else. Strict: size, time and shape. */
export async function fetchNodeId(address: string, deps: NodeInfoDeps = {}): Promise<string | null> {
  if (!isLocalNodeHost(address)) return null;
  const read = await readNodeInfo(address, deps);
  return read.kind === "ok" ? read.nodeId : null;
}

/** Whether anything answers at `<address>/info` at all, ignoring cross-origin rules (the answer is opaque and never read). */
async function answersAtAll(address: string, deps: NodeInfoDeps): Promise<boolean> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? NODE_INFO_TIMEOUT_MS);
  try {
    await doFetch(`${address}/info`, { method: "GET", mode: "no-cors", cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) {
    const text = await response.text();
    return text.length > maxBytes ? null : text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** What the node at `address` is, compared with the node ID saved for it. */
export async function checkNode(address: string | undefined, deps: NodeInfoDeps = {}): Promise<NodeCheck> {
  if (!address || !isLocalNodeHost(address)) return { kind: "hosted" };
  const read = await readNodeInfo(address, deps);
  if (read.kind === "bad") return { kind: "unreachable" };
  if (read.kind === "failed") return (await answersAtAll(address, deps)) ? { kind: "blocked" } : { kind: "unreachable" };
  const currentId = read.nodeId;
  const pin = readNodePin(address);
  if (!pin) return { kind: "first-use", nodeId: currentId };
  return pin.nodeId === currentId ? { kind: "match", nodeId: currentId } : { kind: "mismatch", savedId: pin.nodeId, currentId };
}

/** The shape of the SDK's failure to read a node's /info during sign-in (`VersionCheckError`), or a plain network failure. */
export function isNodeFetchFailure(caught: unknown): boolean {
  if (!(caught instanceof Error)) return false;
  return caught.name === "VersionCheckError" || /failed to fetch node info|failed to fetch|load failed|networkerror/i.test(caught.message);
}
