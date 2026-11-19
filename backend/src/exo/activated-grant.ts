import { assertKvResult, isKvMissingKeyResult } from "@tinyboilerplate/server";
import { getAddress, isAddress } from "viem";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX, type VerifiedTranscriptWriter } from "../delegation-verify.js";

export interface ExoKvGetOptions {
  source?: "network";
  maxResponseBytes?: number;
}

export interface ExoKvPutOptions {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

/** The KV methods an activated exo grant provides. An activated `DelegatedAccess` satisfies this shape. */
export interface ExoKvAccess {
  get(key: string, options?: ExoKvGetOptions): Promise<unknown>;
  list(options: { prefix: string }): Promise<unknown>;
  put(key: string, value: unknown, options?: ExoKvPutOptions): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export type ExoGrantIdentity = Pick<VerifiedTranscriptWriter, "policy" | "ownerAddress" | "chainId" | "spaceId">;

export interface ExoActivatedGrant {
  requestsGet(path: string): Promise<unknown | undefined>;
  requestsList(directory: string): Promise<string[]>;
  requestsRemove(path: string): Promise<void>;
  jobsGet(path: string): Promise<unknown | undefined>;
  jobsPut(path: string, value: unknown): Promise<void>;
  jobsPutIfAbsent(path: string, value: unknown): Promise<boolean>;
  jobsList(directory: string): Promise<string[]>;
  jobsRemove(path: string): Promise<void>;
}

/** Owner applications space with the EIP-55 checksummed address. Callers compare it case-insensitively. */
export function ownerApplicationsSpaceUri(ownerAddress: string, chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error(`Owner chain id refused: ${String(chainId)}`);
  if (!isAddress(ownerAddress)) throw new Error(`Owner address refused: ${ownerAddress}`);
  return `tinycloud:pkh:eip155:${chainId}:${getAddress(ownerAddress)}:applications`;
}

const MAX_KEY_LENGTH = 512;
const KEY_CHARACTERS = /^[A-Za-z0-9._/-]+$/;

/**
 * Literal paths only: under `prefix`, ASCII key characters only (no NUL, control, non-ASCII, or
 * lookalike characters, no percent-encoding, no backslash), at most 512 characters, no empty, `.`
 * or `..` segment, no trailing slash.
 */
function assertLiteralPathUnder(prefix: string, path: string): string {
  if (typeof path !== "string" || path.length > MAX_KEY_LENGTH || !KEY_CHARACTERS.test(path) || !path.startsWith(prefix)) {
    throw new Error(`Exo grant path refused: ${String(path)}`);
  }
  const rest = path.slice(prefix.length);
  if (rest === "" || rest.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Exo grant path refused: ${path}`);
  }
  return path;
}

/** Reads `.data` from a KV result envelope. Returns undefined when the envelope has no `data`. */
function dataOf(envelope: unknown): unknown {
  return envelope !== null && typeof envelope === "object" && "data" in envelope ? envelope.data : undefined;
}

/** Reads `.keys` from a KV list payload. */
function keysOf(listed: unknown): unknown {
  return listed !== null && typeof listed === "object" && "keys" in listed ? listed.keys : undefined;
}

const MAX_STORED_BYTES = 4 * 1024;

/**
 * KV values may be raw JSON bytes, a JSON string, or an already-parsed value. Raw bytes and strings
 * are capped at 4 KiB, must not start with a byte order mark, and must be valid UTF-8. A JSON `null`
 * reads as absent.
 */
function decodeStoredJson(raw: unknown): unknown {
  let text: string;
  if (raw instanceof ArrayBuffer || raw instanceof Uint8Array) {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
    if (bytes.byteLength > MAX_STORED_BYTES) throw new Error("Exo stored value exceeds 4 KiB");
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error("Exo stored value has a byte order mark");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_STORED_BYTES) throw new Error("Exo stored value exceeds 4 KiB");
    if (raw.charCodeAt(0) === 0xfeff) throw new Error("Exo stored value has a byte order mark");
    text = raw;
  } else {
    return raw;
  }
  const parsed: unknown = JSON.parse(text);
  return parsed === null ? undefined : parsed;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Read bound for one request or job record. Stored JSON is separately capped at 4 KiB. */
const MAX_RECORD_RESPONSE_BYTES = 16 * 1024;

export function isKvPreconditionFailed(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const candidate = result as { ok?: unknown; error?: unknown };
  if (candidate.ok !== false || candidate.error === null || typeof candidate.error !== "object") return false;
  return (candidate.error as { code?: unknown }).code === "KV_PRECONDITION_FAILED";
}

/**
 * Reads a KV get result with its strong etag, for a conditional write. Undefined when the key is absent.
 * Throws when the etag is missing or weak (`W/`), or the value is missing, so a later write is never silently unconditional.
 */
export function readVersionedKv(result: unknown, key: string): { value: unknown; etag: string } | undefined {
  if (isKvMissingKeyResult(result, key)) return undefined;
  const outer = dataOf(assertKvResult(result));
  if (outer === null || typeof outer !== "object") throw new Error("Exo ledger read invalid");
  const headers = "headers" in outer ? outer.headers : undefined;
  const etag = headers !== null && typeof headers === "object" && "etag" in headers ? headers.etag : undefined;
  if (typeof etag !== "string" || etag === "" || etag.startsWith("W/")) throw new Error("Exo ledger read without a strong etag");
  const raw = "data" in outer ? outer.data : undefined;
  if (raw === null || raw === undefined) throw new Error("Exo ledger value missing");
  return { value: decodeStoredJson(raw), etag };
}

/**
 * Typed access to an activated exo-sync grant. Every path is checked against the shared prefixes
 * before the node is called. Only the six methods below are exposed.
 */
export function createExoActivatedGrant(access: { kv: ExoKvAccess }, grant: ExoGrantIdentity): ExoActivatedGrant {
  if (grant.policy !== "exo-sync") throw new Error("Exo grant accessor requires an exo-sync grant");
  if (grant.spaceId.toLowerCase() !== ownerApplicationsSpaceUri(grant.ownerAddress, grant.chainId).toLowerCase()) {
    throw new Error("Exo grant space does not match its owner");
  }
  const kv = access.kv;
  const readJson = async (path: string): Promise<unknown | undefined> => {
    const result = await kv.get(path, { source: "network", maxResponseBytes: MAX_RECORD_RESPONSE_BYTES });
    if (isKvMissingKeyResult(result, path)) return undefined;
    const outer = dataOf(assertKvResult(result));
    const raw = outer !== null && typeof outer === "object" && "data" in outer ? outer.data : outer;
    if (raw === null || raw === undefined) return undefined;
    return decodeStoredJson(raw);
  };
  const listUnder = async (prefix: string, directory: string): Promise<string[]> => {
    if (typeof directory !== "string" || !directory.endsWith("/")) {
      throw new Error(`Exo grant directory refused: ${String(directory)}`);
    }
    if (directory !== prefix) assertLiteralPathUnder(prefix, directory.slice(0, -1));
    const listed = dataOf(assertKvResult(await kv.list({ prefix: directory })));
    const keys = keysOf(listed);
    if (!Array.isArray(keys) || !keys.every((key) => isString(key) && key.startsWith(directory))) {
      throw new Error("Exo grant listing invalid");
    }
    return keys;
  };
  return {
    requestsGet: async (path) => readJson(assertLiteralPathUnder(EXO_REQUESTS_PREFIX, path)),
    requestsList: async (directory) => listUnder(EXO_REQUESTS_PREFIX, directory),
    requestsRemove: async (path) => {
      const result = await kv.delete(assertLiteralPathUnder(EXO_REQUESTS_PREFIX, path));
      if (!isKvMissingKeyResult(result, path)) assertKvResult(result);
    },
    jobsGet: async (path) => readJson(assertLiteralPathUnder(EXO_JOBS_PREFIX, path)),
    jobsPut: async (path, value) => {
      assertKvResult(await kv.put(assertLiteralPathUnder(EXO_JOBS_PREFIX, path), value));
    },
    jobsPutIfAbsent: async (path, value) => {
      const result = await kv.put(assertLiteralPathUnder(EXO_JOBS_PREFIX, path), value, { ifNoneMatch: "*" });
      if (isKvPreconditionFailed(result)) return false;
      assertKvResult(result);
      return true;
    },
    jobsList: async (directory) => listUnder(EXO_JOBS_PREFIX, directory),
    jobsRemove: async (path) => {
      const result = await kv.delete(assertLiteralPathUnder(EXO_JOBS_PREFIX, path));
      if (!isKvMissingKeyResult(result, path)) assertKvResult(result);
    },
  };
}
