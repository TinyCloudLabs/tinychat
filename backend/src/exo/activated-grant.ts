import { assertKvResult, isKvMissingKeyResult } from "@tinyboilerplate/server";
import { getAddress, isAddress } from "viem";
import { EXO_JOBS_PREFIX, EXO_REQUESTS_PREFIX, type VerifiedTranscriptWriter } from "../delegation-verify.js";

/** The KV methods an activated exo grant provides. An activated `DelegatedAccess` satisfies this shape. */
export interface ExoKvAccess {
  get(key: string): Promise<unknown>;
  list(options: { prefix: string }): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export type ExoGrantIdentity = Pick<VerifiedTranscriptWriter, "policy" | "ownerAddress" | "chainId" | "spaceId">;

export interface ExoActivatedGrant {
  requestsGet(path: string): Promise<unknown | undefined>;
  requestsList(directory: string): Promise<string[]>;
  requestsRemove(path: string): Promise<void>;
  jobsGet(path: string): Promise<unknown | undefined>;
  jobsPut(path: string, value: unknown): Promise<void>;
  jobsRemove(path: string): Promise<void>;
}

/** Owner applications space with the EIP-55 checksummed address. Callers compare it case-insensitively. */
export function ownerApplicationsSpaceUri(ownerAddress: string, chainId: number): string {
  if (!isAddress(ownerAddress)) throw new Error(`Owner address refused: ${ownerAddress}`);
  return `tinycloud:pkh:eip155:${chainId}:${getAddress(ownerAddress)}:applications`;
}

/** Literal paths only: under `prefix`, no percent-encoding, no backslash, no empty, `.` or `..` segment, no trailing slash. */
function assertLiteralPathUnder(prefix: string, path: string): string {
  if (typeof path !== "string" || !path.startsWith(prefix) || /[%\\]/.test(path)) {
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

/** KV values may be raw JSON bytes, a JSON string, or an already-parsed value. */
function decodeStoredJson(raw: unknown): unknown {
  if (raw instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(raw)));
  if (raw instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(raw));
  if (typeof raw === "string") return JSON.parse(raw);
  return raw;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
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
    const result = await kv.get(path);
    if (isKvMissingKeyResult(result, path)) return undefined;
    const outer = dataOf(assertKvResult(result));
    const raw = dataOf(outer) ?? outer;
    if (raw === null || raw === undefined) return undefined;
    return decodeStoredJson(raw);
  };
  return {
    requestsGet: async (path) => readJson(assertLiteralPathUnder(EXO_REQUESTS_PREFIX, path)),
    requestsList: async (directory) => {
      if (typeof directory !== "string" || !directory.endsWith("/")) {
        throw new Error(`Exo grant directory refused: ${String(directory)}`);
      }
      assertLiteralPathUnder(EXO_REQUESTS_PREFIX, directory.slice(0, -1));
      const listed = dataOf(assertKvResult(await kv.list({ prefix: directory })));
      const keys = keysOf(listed);
      if (!Array.isArray(keys) || !keys.every(isString)) throw new Error("Exo grant listing invalid");
      return keys;
    },
    requestsRemove: async (path) => {
      assertKvResult(await kv.delete(assertLiteralPathUnder(EXO_REQUESTS_PREFIX, path)));
    },
    jobsGet: async (path) => readJson(assertLiteralPathUnder(EXO_JOBS_PREFIX, path)),
    jobsPut: async (path, value) => {
      assertKvResult(await kv.put(assertLiteralPathUnder(EXO_JOBS_PREFIX, path), value));
    },
    jobsRemove: async (path) => {
      assertKvResult(await kv.delete(assertLiteralPathUnder(EXO_JOBS_PREFIX, path)));
    },
  };
}
