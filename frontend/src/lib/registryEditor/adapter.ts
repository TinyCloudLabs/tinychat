// TC-3892: thin, mockable adapter for reading the owner's location-registry v2 record,
// listing OpenKey registry-change history, and invoking OpenKey.requestRegistryChange /
// OpenKey.requestRegistryUndo (TC-3890 contract). Feature-detects both SDK methods so
// older SDK builds hide edit/undo cleanly without crashing.
import OpenKey from "@openkey/sdk";
import {
  DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL,
  exactHttpOrigin,
  registryOwnerKeyV2,
  validateLocationRecordV2,
  verifyLocationRecordV2,
  type LocationRecordV2,
} from "@tinycloud/sdk-core";
import { openkeyPasskeysSupported } from "../openkeyPasskeys";
import { isNativeOpenKeySession } from "../openkeyNative";
import { logSession } from "../debugLog";

const DEFAULT_OPENKEY_HOST = "https://openkey.so";
const DEFAULT_HISTORY_LIMIT = 10;

export interface RegistryChangeNodeInput {
  url: string;
  did?: string;
}

export interface RegistryChangeSpaceNodeInput {
  url: string;
  mode?: "read-write" | "read-only";
}

export interface RegistryChangeSpaceInput {
  space: string;
  nodes: RegistryChangeSpaceNodeInput[];
}

/**
 * Request payload for `OpenKey.requestRegistryChange` (TC-3890 contract).
 * `encryptionNode` is the canonical node URL (equal to one of `nodes[].url`) or `null`.
 * `spaces[].nodes[].url` likewise reference `nodes[].url`.
 */
export interface RegistryChangeRequest {
  nodes: RegistryChangeNodeInput[];
  spaces?: RegistryChangeSpaceInput[];
  encryptionNode?: string | null;
}

/** Request payload for `OpenKey.requestRegistryUndo` (server-built undo/restore by history row ID). */
export interface RegistryUndoRequest {
  historyId: string;
}

export type RegistryChangeOutcome =
  | { status: "published"; sequence: number; recordHash: string }
  | { status: "cancelled" };

/** Slice of the OpenKey client SDK used by the Registry editor. */
export interface RegistryChangeClient {
  requestRegistryChange?: (request: RegistryChangeRequest) => Promise<RegistryChangeOutcome>;
  requestRegistryUndo?: (request: RegistryUndoRequest) => Promise<RegistryChangeOutcome>;
}

/** Accepts either an installed `OpenKey` instance (which may predate the methods) or a mockable client. */
export type RegistryChangeClientLike = OpenKey | RegistryChangeClient;

export interface RegistryChangeHistoryEntry {
  id: string;
  requestingOrigin: string;
  previousRecord: LocationRecordV2;
  newRecordHash: string;
  newSequence: number;
  createdAt: string;
}

export type CurrentLocationRecordResult =
  | { status: "found"; record: LocationRecordV2 }
  | { status: "missing" }
  | { status: "error"; reason: "unreachable" | "invalid" };

export type RegistryHistoryResult =
  | { status: "ok"; history: RegistryChangeHistoryEntry[] }
  | { status: "error"; reason: "unreachable" | "invalid" };

export interface RegistryEditorAdapter {
  readonly canEdit: boolean;
  readonly canUndo: boolean;
  readCurrentRecord: (did: string, signal?: AbortSignal) => Promise<CurrentLocationRecordResult>;
  fetchHistory: (did: string, signal?: AbortSignal) => Promise<RegistryHistoryResult>;
  requestChange: (request: RegistryChangeRequest) => Promise<RegistryChangeOutcome>;
  requestUndo: (request: RegistryUndoRequest) => Promise<RegistryChangeOutcome>;
}

/** Feature detection: true only when the OpenKey client exposes `requestRegistryChange`. */
export function canRequestRegistryChange(
  client: RegistryChangeClientLike | null | undefined,
): client is RegistryChangeClient & Required<Pick<RegistryChangeClient, "requestRegistryChange">> {
  return typeof (client as RegistryChangeClient | null | undefined)?.requestRegistryChange === "function";
}

/** Feature detection: true only when the OpenKey client exposes `requestRegistryUndo`. */
export function canRequestRegistryUndo(
  client: RegistryChangeClientLike | null | undefined,
): client is RegistryChangeClient & Required<Pick<RegistryChangeClient, "requestRegistryUndo">> {
  return typeof (client as RegistryChangeClient | null | undefined)?.requestRegistryUndo === "function";
}

/** True when the installed `@openkey/sdk` prototype defines `requestRegistryChange`. */
export function openKeySdkSupportsRegistryChange(): boolean {
  return typeof (OpenKey.prototype as unknown as RegistryChangeClient).requestRegistryChange === "function";
}

/** True when the installed `@openkey/sdk` prototype defines `requestRegistryUndo`. */
export function openKeySdkSupportsRegistryUndo(): boolean {
  return typeof (OpenKey.prototype as unknown as RegistryChangeClient).requestRegistryUndo === "function";
}

/**
 * Derive OpenKey's API origin from its widget host, matching `@openkey/sdk` and `openkeyNative.ts`:
 * prefix `api.` to non-loopback hostnames; keep loopback hosts on the same origin.
 */
export function deriveOpenKeyApiHost(openkeyHost: string = DEFAULT_OPENKEY_HOST): string {
  const url = new URL(openkeyHost);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]") {
    return url.origin;
  }
  if (!url.hostname.startsWith("api.")) {
    url.hostname = `api.${url.hostname}`;
  }
  return url.origin;
}

/** Canonical `scheme://host[:port]` origin for a node URL, using sdk-core's `exactHttpOrigin`. */
export function canonicalNodeOrigin(raw: string): string {
  return exactHttpOrigin(raw.trim(), "node URL");
}

/** Display form of a node URL: canonical `host[:port]` (port shown only when non-default). */
export function displayCanonicalHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

/** True for subjects that location-registry v2 accepts (`did:pkh:` or `did:key:`). */
export function isV2LocationSubject(did: string | null | undefined): did is string {
  return typeof did === "string" && (did.startsWith("did:pkh:") || did.startsWith("did:key:"));
}

/**
 * Read and cryptographically verify the owner's current location-registry v2 record
 * via `GET <registry>/v2/locations/{ownerKey}` + `verifyLocationRecordV2`.
 */
export async function readCurrentLocationRecord(
  did: string,
  options: {
    registryUrl?: string;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    verify?: (record: LocationRecordV2) => Promise<boolean>;
  } = {},
): Promise<CurrentLocationRecordResult> {
  if (!isV2LocationSubject(did)) {
    return { status: "missing" };
  }
  const registryUrl = (options.registryUrl ?? DEFAULT_TINYCLOUD_LOCATION_REGISTRY_URL).replace(/\/$/, "");
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const verifyFn = options.verify ?? verifyLocationRecordV2;
  const ownerKey = registryOwnerKeyV2(did);
  const endpoint = `${registryUrl}/v2/locations/${encodeURIComponent(ownerKey)}`;

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logSession("registry_editor_read", "error", error);
    return { status: "error", reason: "unreachable" };
  }

  if (response.status === 404) {
    return { status: "missing" };
  }
  if (!response.ok) {
    return { status: "error", reason: "unreachable" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", reason: "invalid" };
  }

  if (body === null || typeof body !== "object" || Array.isArray(body) || !("record" in body)) {
    return { status: "error", reason: "invalid" };
  }

  let record: LocationRecordV2;
  try {
    record = validateLocationRecordV2((body as { record: unknown }).record);
  } catch {
    return { status: "error", reason: "invalid" };
  }

  if (registryOwnerKeyV2(record.subject).toLowerCase() !== ownerKey.toLowerCase()) {
    return { status: "error", reason: "invalid" };
  }

  try {
    const verified = await verifyFn(record);
    if (!verified) {
      return { status: "error", reason: "invalid" };
    }
  } catch {
    return { status: "error", reason: "invalid" };
  }

  return { status: "found", record };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseHistoryEntry(raw: unknown): RegistryChangeHistoryEntry {
  if (!isPlainObject(raw)) {
    throw new Error("history entry must be an object");
  }
  const { id, requestingOrigin, previousRecord, newRecordHash, newSequence, createdAt } = raw;
  if (
    !isNonEmptyString(id) ||
    !isNonEmptyString(requestingOrigin) ||
    !isNonEmptyString(newRecordHash) ||
    !isNonEmptyString(createdAt) ||
    typeof newSequence !== "number" ||
    !Number.isSafeInteger(newSequence) ||
    newSequence < 0
  ) {
    throw new Error("history entry has invalid metadata");
  }
  const validatedRecord = validateLocationRecordV2(previousRecord);
  return {
    id,
    requestingOrigin,
    previousRecord: validatedRecord,
    newRecordHash,
    newSequence,
    createdAt,
  };
}

/**
 * Fetch and cryptographically verify the owner's recent registry changes from OpenKey
 * `GET /api/registry-change/history`.
 * Strictly parses ONLY `{ history: [{ id, requestingOrigin, previousRecord, newRecordHash, newSequence, createdAt }] }`.
 * Every row's `previousRecord` must pass `verifyLocationRecordV2` and match the caller's owner key;
 * any invalid shape or failed verification marks the whole list invalid (`{ status: "error", reason: "invalid" }`).
 */
export async function fetchRegistryChangeHistory(
  openkeyHost: string = DEFAULT_OPENKEY_HOST,
  did: string,
  options: {
    limit?: number;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    verify?: (record: LocationRecordV2) => Promise<boolean>;
  } = {},
): Promise<RegistryHistoryResult> {
  if (!isV2LocationSubject(did)) {
    return { status: "error", reason: "invalid" };
  }
  const expectedOwnerKey = registryOwnerKeyV2(did).toLowerCase();
  const limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const verifyFn = options.verify ?? verifyLocationRecordV2;

  let apiOrigin: string;
  try {
    apiOrigin = deriveOpenKeyApiHost(openkeyHost);
  } catch {
    return { status: "error", reason: "invalid" };
  }
  const endpoint = `${apiOrigin}/api/registry-change/history?limit=${encodeURIComponent(String(limit))}`;

  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    logSession("registry_editor_history", "error", error);
    return { status: "error", reason: "unreachable" };
  }

  if (!response.ok) {
    return { status: "error", reason: "unreachable" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "error", reason: "invalid" };
  }

  if (!isPlainObject(body) || !Array.isArray(body.history)) {
    return { status: "error", reason: "invalid" };
  }

  try {
    const history = body.history.map(parseHistoryEntry);
    for (const entry of history) {
      if (registryOwnerKeyV2(entry.previousRecord.subject).toLowerCase() !== expectedOwnerKey) {
        return { status: "error", reason: "invalid" };
      }
      const verified = await verifyFn(entry.previousRecord);
      if (!verified) {
        return { status: "error", reason: "invalid" };
      }
    }
    return { status: "ok", history };
  } catch {
    return { status: "error", reason: "invalid" };
  }
}

/**
 * Canonicalize a registry change request before handing it to OpenKey:
 * - Every node URL is canonicalized with `exactHttpOrigin` (`scheme://host[:port]`).
 * - `nodes` is deduplicated by canonical URL and includes every URL referenced by
 *   `spaces` or `encryptionNode` as well as all explicitly supplied nodes.
 * - An existing node's `did` is carried over ONLY when its canonical URL is unchanged.
 * - `encryptionNode` is canonicalized to a node URL (equal to one of `nodes[].url`) or `null`.
 */
export function canonicalizeRegistryChangeRequest(
  input: RegistryChangeRequest,
  existingNodes: ReadonlyArray<{ did: string; url: string }> = [],
): RegistryChangeRequest {
  const existingDidByUrl = new Map<string, string>();
  for (const node of existingNodes) {
    try {
      existingDidByUrl.set(canonicalNodeOrigin(node.url), node.did);
    } catch {
      // Ignore unparseable existing URLs.
    }
  }

  const nodeMap = new Map<string, RegistryChangeNodeInput>();
  const addNode = (rawUrl: string, explicitDid?: string): string => {
    const url = canonicalNodeOrigin(rawUrl);
    const existing = nodeMap.get(url);
    const did = explicitDid ?? existing?.did ?? existingDidByUrl.get(url);
    nodeMap.set(url, did ? { url, did } : { url });
    return url;
  };

  for (const node of input.nodes) {
    addNode(node.url, node.did);
  }

  const spaces = input.spaces?.map((space) => ({
    space: space.space,
    nodes: space.nodes.map((member) => {
      const url = addNode(member.url);
      return member.mode ? { url, mode: member.mode } : { url };
    }),
  }));

  let encryptionNode: string | null | undefined;
  if (input.encryptionNode === null) {
    encryptionNode = null;
  } else if (typeof input.encryptionNode === "string") {
    const trimmed = input.encryptionNode.trim();
    encryptionNode = trimmed.length === 0 ? null : addNode(trimmed);
  }

  const nodes = [...nodeMap.values()];
  if (nodes.length === 0) {
    throw new Error("at least one node URL is required");
  }

  const result: RegistryChangeRequest = { nodes };
  if (spaces !== undefined) {
    result.spaces = spaces;
  }
  if (encryptionNode !== undefined) {
    result.encryptionNode = encryptionNode;
  }
  return result;
}

/**
 * Count how many space-host assignments plus encryption-node assignment changed between
 * `previous` and `next`. Used for `{n} changes` in the Recent changes list.
 */
export function countRecordChanges(previous: LocationRecordV2, next: LocationRecordV2 | null): number {
  if (!next) {
    return Math.max(1, previous.spaces.length + (previous.encryptionNode ? 1 : 0));
  }
  const urlMap = (rec: LocationRecordV2) =>
    new Map(rec.nodes.map((n) => [n.did, displayCanonicalHost(n.url)]));
  const prevUrls = urlMap(previous);
  const nextUrls = urlMap(next);

  const spaceKey = (rec: LocationRecordV2, urls: Map<string, string>) => {
    const map = new Map<string, string>();
    for (const s of rec.spaces) {
      const sig = s.nodes
        .map((m) => `${urls.get(m.did) ?? m.did}:${m.mode}`)
        .sort()
        .join(",");
      map.set(s.space, sig);
    }
    return map;
  };

  const prevSpaces = spaceKey(previous, prevUrls);
  const nextSpaces = spaceKey(next, nextUrls);
  const allSpaces = new Set([...prevSpaces.keys(), ...nextSpaces.keys()]);
  let changes = 0;
  for (const space of allSpaces) {
    if (prevSpaces.get(space) !== nextSpaces.get(space)) {
      changes += 1;
    }
  }

  const prevEnc = previous.encryptionNode ? (prevUrls.get(previous.encryptionNode) ?? previous.encryptionNode) : null;
  const nextEnc = next.encryptionNode ? (nextUrls.get(next.encryptionNode) ?? next.encryptionNode) : null;
  if (prevEnc !== nextEnc) {
    changes += 1;
  }

  return Math.max(1, changes);
}

/** Format an ISO timestamp concisely for UI labels. */
export function formatRegistryDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toISOString();
  }
}

/**
 * Create the production adapter for `RegistrySection`.
 * If `openkey` is omitted and the installed `@openkey/sdk` exposes `requestRegistryChange`
 * or `requestRegistryUndo` (on non-native web sessions), lazily instantiates an `OpenKey`
 * client for `openkeyHost`.
 */
export function createRegistryEditorAdapter(options: {
  openkey?: RegistryChangeClientLike | null;
  openkeyHost?: string;
  registryUrl?: string;
  fetch?: typeof fetch;
  appName?: string;
} = {}): RegistryEditorAdapter {
  const openkeyHost = options.openkeyHost || DEFAULT_OPENKEY_HOST;

  let client: RegistryChangeClientLike | null = options.openkey ?? null;
  if (
    !client &&
    !isNativeOpenKeySession() &&
    (openKeySdkSupportsRegistryChange() || openKeySdkSupportsRegistryUndo())
  ) {
    client = new OpenKey({
      host: openkeyHost,
      appName: options.appName ?? "TinyCloud One",
      passkeysSupported: openkeyPasskeysSupported(),
    });
  }

  const canEdit = canRequestRegistryChange(client);
  const canUndo = canRequestRegistryUndo(client);

  return {
    canEdit,
    canUndo,
    readCurrentRecord: (did, signal) =>
      readCurrentLocationRecord(did, {
        registryUrl: options.registryUrl,
        fetch: options.fetch,
        signal,
      }),
    fetchHistory: (did, signal) =>
      fetchRegistryChangeHistory(openkeyHost, did, {
        fetch: options.fetch,
        signal,
      }),
    requestChange: async (request) => {
      if (!canRequestRegistryChange(client)) {
        throw new Error("OpenKey.requestRegistryChange is not available");
      }
      return client.requestRegistryChange(request);
    },
    requestUndo: async (request) => {
      if (!canRequestRegistryUndo(client)) {
        throw new Error("OpenKey.requestRegistryUndo is not available");
      }
      return client.requestRegistryUndo(request);
    },
  };
}
