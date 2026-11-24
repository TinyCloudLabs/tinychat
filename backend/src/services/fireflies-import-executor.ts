import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { activateSessionWithHost, isStorageFullError } from "@tinycloud/sdk-core";
import {
  evictDelegateNodeGrants,
  type FirefliesDelegateIdentity,
} from "../fireflies-import-identity.js";
import type { VerifiedFirefliesImportGrants } from "../fireflies-import-verify.js";
import { DelegationActivationError, nodeRevocationCode } from "../portable-delegation.js";
import { TenantCoordinator } from "./calendar-autojoin-store.js";
import { withConnectorConnectionChange } from "./connector-connection-lane.js";
import { isTombstoned, tombstoneReason } from "./connector-drain.js";

type FirefliesPurgeLedger = NonNullable<Parameters<typeof isTombstoned>[1]>;

export type FirefliesPurgeLedgerRead =
  | { status: "absent" }
  | { status: "unparseable"; raw: unknown }
  | { status: "ok"; ledger: FirefliesPurgeLedger };
import {
  fetchFirefliesMeeting,
  type FirefliesFetchErrorCode,
  type FirefliesFetchOptions,
  type FirefliesFetchRequest,
  type FirefliesFetchResult,
  type NormalizedFirefliesImport,
} from "./fireflies-fetch.js";
import type { FirefliesGrantStore } from "./fireflies-grant-store.js";
import { keyedLogHash } from "./webhook-tokens.js";

export const FIREFLIES_SOURCE = "fireflies" as const;
export const FIREFLIES_SECRET_NAME = "FIREFLIES_API_KEY" as const;
export const DEFAULT_FIREFLIES_MAX_CONCURRENT = 3;
export const DEFAULT_FIREFLIES_PER_USER_SPACING_MS = 800;
const MAX_TRACKED_TENANTS = 10_000;

function setBoundedMap<V>(map: Map<string, V>, key: string, value: V, maxSize = MAX_TRACKED_TENANTS): void {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function firefliesMeetingKvKey(meetingId: string): string {
  return `${CONNECTORS_KV_PREFIX}/${FIREFLIES_SOURCE}/meeting/${meetingId}`;
}

export function firefliesTranscriptKvKey(meetingId: string): string {
  return `${CONNECTORS_KV_PREFIX}/${FIREFLIES_SOURCE}/transcript/${meetingId}`;
}

export type FirefliesImportOutcome =
  | "imported"
  | "already_present"
  | "tombstoned"
  | "stopped_needs_renewal"
  | "stopped_revoked"
  | "missing_secret"
  | "resave_required"
  | "storage_full"
  | "fireflies_error"
  | "node_error";

export type FirefliesWebhookExecutionResult =
  | { handled: false }
  | {
      handled: true;
      httpStatus: 200 | 503;
      body: Record<string, unknown>;
      outcome: FirefliesImportOutcome;
    };

export interface FirefliesImportMetrics {
  attempted: number;
  imported: number;
  alreadyPresent: number;
  tombstoned: number;
  stoppedNeedsRenewal: number;
  stoppedRevoked: number;
  missingSecret: number;
  resaveRequired: number;
  storageFull: number;
  firefliesErrors: number;
  nodeErrors: number;
  redirectRefused: number;
  responseTooLarge: number;
}

export type FirefliesGrantCheckOutcome =
  | { status: "ok" }
  | { status: "revoked" }
  | { status: "unauthorized" }
  | { status: "error" };

export type FirefliesSecretReadOutcome =
  | { status: "ok"; value: string }
  | { status: "revoked" }
  | { status: "unauthorized" }
  | { status: "missing" }
  | { status: "resave_required" }
  | { status: "error" };

export type FirefliesMeetingWriteOutcome =
  | { status: "written" }
  | { status: "already_present" }
  | { status: "tombstoned" }
  | { status: "revoked" }
  | { status: "unauthorized" }
  | { status: "storage_full" }
  | { status: "error" };

export type FirefliesWriteGuard = <T>(
  writeOp: () => Promise<T>,
) => Promise<{ guarded: true; result: T } | { guarded: false; status: "tombstoned" | "error" }>;

export interface FirefliesDirectImporterOptions {
  delegate: FirefliesDelegateIdentity;
  grantStore: Pick<FirefliesGrantStore, "loadActive" | "markState">;
  configuredHost: string;
  control?: {
    readLedger(source: string, address: string): Promise<FirefliesPurgeLedgerRead>;
  };
  /**
   * TC-3344 per-tenant reset timestamp reader. Replay markers written strictly before this ISO
   * timestamp are ignored so an eligible re-notification after reconnect / "Allow deleted meetings
   * back" imports cleanly.
   */
  resetTimestampFor?: (source: string, address: string) => Promise<string | null>;
  fetchMeeting?: (
    request: FirefliesFetchRequest,
    options?: FirefliesFetchOptions,
  ) => Promise<FirefliesFetchResult>;
  fetchOptions?: FirefliesFetchOptions;
  /** Override for live G2 grant validation before Fireflies fetch; defaults to POST {host}/delegate. */
  checkMeetingsGrant?: (
    scopedNode: TinyCloudNode,
    verified: VerifiedFirefliesImportGrants,
  ) => Promise<FirefliesGrantCheckOutcome>;
  /** Override for G1 secret read; defaults to scoped delegate node activation + readSecret. */
  readSecretKey?: (
    scopedNode: TinyCloudNode,
    verified: VerifiedFirefliesImportGrants,
  ) => Promise<FirefliesSecretReadOutcome>;
  /** Override for G2 KV-only write; defaults to scoped delegate node activation + kv.put(ifNoneMatch: "*"). */
  writeMeeting?: (
    scopedNode: TinyCloudNode,
    verified: VerifiedFirefliesImportGrants,
    normalized: NormalizedFirefliesImport,
  ) => Promise<FirefliesMeetingWriteOutcome>;
  coordinator?: TenantCoordinator;
  maxConcurrent?: number;
  perUserSpacingMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Optional callback fired ONLY on a completed write; never fired on `storage_full` (TC-1192). */
  onSynced?: (address: string, syncedAtIso: string) => void;
}

export interface FirefliesWebhookDeliveryInput {
  address: string;
  meetingId: string;
  receivedAt: string;
  sourceTimestamp?: string;
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(limit: number) {
    this.available = Math.max(1, limit);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

function extractErrorDetails(error: unknown): {
  status?: number;
  code?: string;
  message: string;
} {
  if (error instanceof DelegationActivationError) {
    return { status: error.status, message: error.body || error.message };
  }
  if (error instanceof Error) {
    const rec = error as Error & { status?: unknown; code?: unknown; cause?: unknown };
    const status =
      typeof rec.status === "number"
        ? rec.status
        : typeof rec.cause === "object" &&
            rec.cause !== null &&
            "status" in rec.cause &&
            typeof (rec.cause as { status?: unknown }).status === "number"
          ? (rec.cause as { status: number }).status
          : undefined;
    const code = typeof rec.code === "string" ? rec.code : undefined;
    return { status, code, message: error.message };
  }
  if (typeof error === "object" && error !== null) {
    const rec = error as {
      status?: unknown;
      code?: unknown;
      message?: unknown;
      meta?: unknown;
    };
    const metaStatus =
      typeof rec.meta === "object" &&
      rec.meta !== null &&
      "status" in rec.meta &&
      typeof (rec.meta as { status?: unknown }).status === "number"
        ? (rec.meta as { status: number }).status
        : undefined;
    const status = typeof rec.status === "number" ? rec.status : metaStatus;
    const code = typeof rec.code === "string" ? rec.code : undefined;
    const message = typeof rec.message === "string" ? rec.message : "";
    return { status, code, message };
  }
  return { message: "" };
}

function classifyNodeFailure(error: unknown): "revoked" | "unauthorized" | "storage_full" | "precondition_failed" | "error" {
  if (
    typeof error === "object" &&
    error !== null &&
    isStorageFullError(error as { code?: string })
  ) {
    return "storage_full";
  }
  const details = extractErrorDetails(error);
  if (nodeRevocationCode(details.message) !== undefined) return "revoked";
  if (details.code && nodeRevocationCode(JSON.stringify({ code: details.code })) !== undefined) {
    return "revoked";
  }
  if (
    details.status === 507 ||
    details.code === "STORAGE_FULL" ||
    details.code === "QUOTA_EXCEEDED"
  ) {
    return "storage_full";
  }
  if (
    details.status === 412 ||
    details.code === "PRECONDITION_FAILED" ||
    details.code === "KV_PRECONDITION_FAILED" ||
    details.code === "ALREADY_EXISTS"
  ) {
    return "precondition_failed";
  }
  if (
    details.status === 401 ||
    details.status === 403 ||
    details.code === "AUTH_REQUIRED" ||
    details.code === "AUTH_EXPIRED" ||
    details.code === "AUTH_UNAUTHORIZED" ||
    details.code === "PERMISSION_DENIED"
  ) {
    return "unauthorized";
  }
  return "error";
}

function codedField(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unhashed";
  }
}

async function activateGrantOnNode(
  node: TinyCloudNode,
  verified: VerifiedFirefliesImportGrants,
  grant: VerifiedFirefliesImportGrants["secrets"],
  configuredHost: string,
) {
  const primary = grant.resources[0]!;
  return node.useDelegation({
    cid: grant.cid,
    delegationHeader: { Authorization: grant.authorization },
    spaceId: grant.spaceId,
    path: primary.path,
    actions: [...primary.actions],
    resources: grant.resources.map((resource) => ({
      service: resource.service,
      space: resource.space,
      path: resource.path,
      actions: [...resource.actions],
    })),
    expiry: grant.expiresAt,
    delegateDID: verified.delegateDid,
    ownerAddress: verified.ownerAddress,
    chainId: verified.chainId,
    host: configuredHost,
  });
}

const DEFAULT_G2_ACTIVATE_TIMEOUT_MS = 5_000;

/**
 * Validate G2 live at the TinyCloud node (`POST {host}/delegate`) before calling Fireflies so a
 * revoked or refused G2 stops with zero Fireflies API calls even when G1 is still valid.
 */
export async function defaultCheckMeetingsGrant(
  scopedNode: TinyCloudNode,
  verified: VerifiedFirefliesImportGrants,
  configuredHost: string,
  activateWithHost: typeof activateSessionWithHost = activateSessionWithHost,
): Promise<FirefliesGrantCheckOutcome> {
  try {
    await activateGrantOnNode(scopedNode, verified, verified.meetings, configuredHost);
    const result = await activateWithHost(
      configuredHost,
      { Authorization: verified.meetings.authorization },
      AbortSignal.timeout(DEFAULT_G2_ACTIVATE_TIMEOUT_MS),
    );
    if (!result.success) {
      const kind = classifyNodeFailure({ status: result.status, message: result.error ?? "" });
      if (kind === "revoked") return { status: "revoked" };
      if (kind === "unauthorized") return { status: "unauthorized" };
      return { status: "error" };
    }
    const targetSpace = verified.meetings.spaceId.toLowerCase();
    if (Array.isArray(result.skipped) && result.skipped.some((space) => space.toLowerCase() === targetSpace)) {
      return { status: "error" };
    }
    return { status: "ok" };
  } catch (error) {
    const kind = classifyNodeFailure(error);
    if (kind === "revoked") return { status: "revoked" };
    if (kind === "unauthorized") return { status: "unauthorized" };
    return { status: "error" };
  }
}

export async function defaultReadSecretKey(
  scopedNode: TinyCloudNode,
  verified: VerifiedFirefliesImportGrants,
  configuredHost: string,
): Promise<FirefliesSecretReadOutcome> {
  try {
    await activateGrantOnNode(scopedNode, verified, verified.secrets, configuredHost);
    const result = await scopedNode.readSecret({
      space: verified.secrets.spaceId,
      name: FIREFLIES_SECRET_NAME,
    });
    if (result.status === "ok" && typeof result.value === "string" && result.value.trim().length > 0) {
      return { status: "ok", value: result.value.trim() };
    }
    if (result.status === "not_found") return { status: "missing" };
    // The stored key is not one this reader can open (still sealed to the whole network, or unreadable as stored).
    // Retrying cannot change that, so it is not an error: only the owner saving the key again fixes it.
    if (
      result.status === "legacy_envelope" ||
      result.status === "corrupt_envelope" ||
      result.status === "invalid_payload"
    ) {
      return { status: "resave_required" };
    }
    if (result.status === "permission_required") return { status: "unauthorized" };
    return { status: "error" };
  } catch (error) {
    const kind = classifyNodeFailure(error);
    if (kind === "revoked") return { status: "revoked" };
    if (kind === "unauthorized") return { status: "unauthorized" };
    return { status: "error" };
  }
}

export async function putIfAbsent(
  kv: Awaited<ReturnType<TinyCloudNode["useDelegation"]>>["kv"],
  key: string,
  value: string,
): Promise<"written" | "already_present" | "revoked" | "unauthorized" | "storage_full" | "error"> {
  try {
    // G2 is a single-resource KV-only delegation, so DelegatedAccess constructs KVService with
    // `prefix = this._delegation.path.replace(/\/$/, "")` (@tinycloud/node-sdk/dist/core.js:3340-3341),
    // unlike multi-resource SQL+KV grants (e.g. user-space-port.ts) where `prefix` is `undefined`.
    // KVService.getFullPath(key, options?.prefix) uses `prefixOverride ?? this._config.prefix ?? ""`
    // (@tinycloud/sdk-services/dist/kv/index.cjs:1084-1087), so passing `prefix: ""` prevents
    // double-prefixing our already-full key (`xyz.tinycloud.tinychat/connectors/fireflies/...`).
    const result = await kv.put(key, value, { ifNoneMatch: "*", prefix: "" });
    if (result && typeof result === "object" && "ok" in result) {
      if (result.ok === true) return "written";
      const kind = classifyNodeFailure((result as { error?: unknown }).error);
      if (kind === "precondition_failed") return "already_present";
      return kind;
    }
    return "written";
  } catch (error) {
    const kind = classifyNodeFailure(error);
    if (kind === "precondition_failed") return "already_present";
    return kind;
  }
}

export async function defaultWriteMeeting(
  scopedNode: TinyCloudNode,
  verified: VerifiedFirefliesImportGrants,
  normalized: NormalizedFirefliesImport,
  configuredHost: string,
  guardWrite?: FirefliesWriteGuard,
): Promise<FirefliesMeetingWriteOutcome> {
  let access;
  try {
    access = await activateGrantOnNode(scopedNode, verified, verified.meetings, configuredHost);
  } catch (error) {
    const kind = classifyNodeFailure(error);
    if (kind === "revoked") return { status: "revoked" };
    if (kind === "unauthorized") return { status: "unauthorized" };
    return { status: "error" };
  }

  const runGuardedPut = async (
    key: string,
    value: string,
  ): Promise<
    "written" | "already_present" | "tombstoned" | "revoked" | "unauthorized" | "storage_full" | "error"
  > => {
    if (!guardWrite) return putIfAbsent(access.kv, key, value);
    const guarded = await guardWrite(() => putIfAbsent(access.kv, key, value));
    if (!guarded.guarded) return guarded.status;
    return guarded.result;
  };

  const meetingId = normalized.meeting.sourceId;
  // Sequential writes on one space: transcript body first, then meeting record, both create-only.
  // Each write re-checks the purge ledger inside the connector connection lane when guarded.
  const transcriptRes = await runGuardedPut(
    firefliesTranscriptKvKey(meetingId),
    normalized.transcriptBody,
  );
  if (transcriptRes !== "written" && transcriptRes !== "already_present") {
    return { status: transcriptRes };
  }

  const meetingRes = await runGuardedPut(
    firefliesMeetingKvKey(meetingId),
    JSON.stringify(normalized.meetingRecord),
  );
  if (meetingRes !== "written" && meetingRes !== "already_present") {
    return { status: meetingRes };
  }

  if (transcriptRes === "already_present" && meetingRes === "already_present") {
    return { status: "already_present" };
  }
  return { status: "written" };
}

function isRetryableFirefliesError(code: FirefliesFetchErrorCode): boolean {
  return (
    code === "rate_limited" ||
    code === "timeout" ||
    code === "network_error" ||
    code === "upstream_error"
  );
}

/**
 * Direct-write Fireflies webhook importer (TC-3905 PR-2):
 * - Zero stored Fireflies keys, zero queued meeting copies, zero temp files or caches.
 * - Uses a fresh isolated session-only delegate node per run and evicts all grants in `finally`.
 * - Fails closed on any node rejection and stops cleanly on lapsed or revoked grants.
 */
export class FirefliesDirectImporter {
  private readonly delegate: FirefliesDelegateIdentity;
  private readonly grantStore: Pick<FirefliesGrantStore, "loadActive" | "markState">;
  private readonly configuredHost: string;
  private readonly control?: FirefliesDirectImporterOptions["control"];
  private readonly resetTimestampFor?: FirefliesDirectImporterOptions["resetTimestampFor"];
  private readonly fetchMeetingImpl: NonNullable<FirefliesDirectImporterOptions["fetchMeeting"]>;
  private readonly fetchOptions?: FirefliesFetchOptions;
  private readonly checkMeetingsGrantImpl: NonNullable<FirefliesDirectImporterOptions["checkMeetingsGrant"]>;
  private readonly readSecretKeyImpl: NonNullable<FirefliesDirectImporterOptions["readSecretKey"]>;
  private readonly customWriteMeetingImpl?: FirefliesDirectImporterOptions["writeMeeting"];
  private readonly coordinator: TenantCoordinator;
  private readonly semaphore: Semaphore;
  private readonly perUserSpacingMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly logFn: (line: string) => void;
  private readonly onSynced?: (address: string, syncedAtIso: string) => void;

  private readonly lastRunAtByAddress = new Map<string, number>();
  private readonly lastSyncedAtByAddress = new Map<string, string>();
  private readonly resetAtByAddress = new Map<string, number>();
  /** In-memory per-tenant dedupe timestamps (never persisted; bounded and reset-aware per TC-3344). */
  private readonly importedMarkers = new Map<string, Map<string, number>>();
  private readonly counts: FirefliesImportMetrics = {
    attempted: 0,
    imported: 0,
    alreadyPresent: 0,
    tombstoned: 0,
    stoppedNeedsRenewal: 0,
    stoppedRevoked: 0,
    missingSecret: 0,
    resaveRequired: 0,
    storageFull: 0,
    firefliesErrors: 0,
    nodeErrors: 0,
    redirectRefused: 0,
    responseTooLarge: 0,
  };

  constructor(options: FirefliesDirectImporterOptions) {
    this.delegate = options.delegate;
    this.grantStore = options.grantStore;
    this.configuredHost = options.configuredHost;
    this.control = options.control;
    this.resetTimestampFor = options.resetTimestampFor;
    this.fetchMeetingImpl = options.fetchMeeting ?? fetchFirefliesMeeting;
    this.fetchOptions = options.fetchOptions;
    this.checkMeetingsGrantImpl =
      options.checkMeetingsGrant ??
      ((scopedNode, verified) => defaultCheckMeetingsGrant(scopedNode, verified, this.configuredHost));
    this.readSecretKeyImpl =
      options.readSecretKey ??
      ((scopedNode, verified) => defaultReadSecretKey(scopedNode, verified, this.configuredHost));
    this.customWriteMeetingImpl = options.writeMeeting;
    this.coordinator = options.coordinator ?? new TenantCoordinator();
    this.semaphore = new Semaphore(options.maxConcurrent ?? DEFAULT_FIREFLIES_MAX_CONCURRENT);
    this.perUserSpacingMs = options.perUserSpacingMs ?? DEFAULT_FIREFLIES_PER_USER_SPACING_MS;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.nowFn = options.now ?? Date.now;
    this.logFn = options.log ?? ((line) => console.log(line));
    this.onSynced = options.onSynced;
  }

  metrics(): FirefliesImportMetrics {
    return { ...this.counts };
  }

  lastSyncedAt(address: string): string | null {
    return this.lastSyncedAtByAddress.get(address.toLowerCase()) ?? null;
  }

  /**
   * Record a TC-3344 per-tenant reset timestamp in memory (wired to `DELETE /purged` in index.ts).
   * Markers recorded strictly before this instant are ignored so eligible re-imports proceed.
   * Note: `ConnectorControlStore` does not persist a reset timestamp across restarts; across a
   * restart the in-memory `importedMarkers` map is already empty, the cleared purge ledger allows
   * re-import, and `ifNoneMatch: "*"` continues to block overwriting existing KV records.
   */
  recordReset(address: string, atMs: number = this.nowFn()): void {
    const normalized = address.toLowerCase();
    const prev = this.resetAtByAddress.get(normalized) ?? 0;
    if (atMs > prev) setBoundedMap(this.resetAtByAddress, normalized, atMs);
  }

  private async effectiveResetMs(address: string): Promise<number | null> {
    const local = this.resetAtByAddress.get(address);
    let external: number | null = null;
    if (this.resetTimestampFor) {
      const iso = await this.resetTimestampFor(FIREFLIES_SOURCE, address);
      if (iso !== null) {
        const parsed = Date.parse(iso);
        if (Number.isFinite(parsed)) external = parsed;
      }
    }
    if (local === undefined && external === null) return null;
    if (local === undefined) return external;
    if (external === null) return local;
    return Math.max(local, external);
  }

  private hasActiveReplayMarker(address: string, meetingId: string, resetMs: number | null): boolean {
    const markers = this.importedMarkers.get(address);
    if (!markers) return false;
    const stamped = markers.get(meetingId);
    if (stamped === undefined) return false;
    if (resetMs !== null && stamped < resetMs) {
      markers.delete(meetingId);
      return false;
    }
    return true;
  }

  private markImported(address: string, meetingId: string, atMs: number): void {
    let markers = this.importedMarkers.get(address);
    if (!markers) {
      markers = new Map<string, number>();
    }
    setBoundedMap(this.importedMarkers, address, markers);
    markers.set(meetingId, atMs);
    if (markers.size > 200) {
      const oldest = markers.keys().next().value;
      if (oldest !== undefined) markers.delete(oldest);
    }
  }

  private emitLog(
    address: string,
    meetingId: string,
    result: string,
    extra: Record<string, string | number> = {},
  ): void {
    const fields = Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    const suffix = fields ? ` ${fields}` : "";
    this.logFn(
      `[fireflies-import] op=direct-import aid=${codedField(address)} mid=${codedField(meetingId)} result=${result}${suffix}`,
    );
  }

  private async checkPurgeLedger(
    address: string,
    item: { meetingId: string; receivedAt: string; sourceTimestamp?: string },
  ): Promise<{ ok: true } | { ok: false; status: "tombstoned"; reason: string } | { ok: false; status: "error" }> {
    if (!this.control) return { ok: true };
    let ledgerRead: FirefliesPurgeLedgerRead;
    try {
      ledgerRead = await this.control.readLedger(FIREFLIES_SOURCE, address);
    } catch {
      return { ok: false, status: "error" };
    }
    if (ledgerRead.status === "unparseable") {
      return { ok: false, status: "tombstoned", reason: "corrupt_ledger" };
    }
    if (ledgerRead.status === "ok" && isTombstoned(item, ledgerRead.ledger)) {
      return { ok: false, status: "tombstoned", reason: tombstoneReason(item, ledgerRead.ledger) };
    }
    return { ok: true };
  }

  async handleWebhook(
    input: FirefliesWebhookDeliveryInput,
  ): Promise<FirefliesWebhookExecutionResult> {
    const address = input.address.toLowerCase();
    const { meetingId, receivedAt, sourceTimestamp } = input;
    const ledgerItem = {
      meetingId,
      receivedAt,
      ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    };

    return this.coordinator.run(address, async () => {
      const nowMs = this.nowFn();
      const loaded = await this.grantStore.loadActive(address, {
        configuredHost: this.configuredHost,
        deps: {
          computeDelegationCid: this.delegate.node.computeDelegationCid.bind(this.delegate.node),
        },
        now: nowMs,
      });

      // Browser-only owner: fall through to Option-C queue enqueue.
      if (loaded.state === "none") {
        return { handled: false };
      }

      this.counts.attempted += 1;

      if (loaded.state === "revoked") {
        this.counts.stoppedRevoked += 1;
        this.emitLog(address, meetingId, "stopped_revoked");
        return {
          handled: true,
          httpStatus: 200,
          body: { status: "revoked" },
          outcome: "stopped_revoked",
        };
      }

      if (loaded.state !== "active") {
        this.counts.stoppedNeedsRenewal += 1;
        this.emitLog(address, meetingId, "stopped_needs_renewal");
        return {
          handled: true,
          httpStatus: 200,
          body: { status: "paused" },
          outcome: "stopped_needs_renewal",
        };
      }
      const verified = loaded.verified;

      // Fast-path purge ledger check before any node or Fireflies call.
      const preFetchLedger = await this.checkPurgeLedger(address, ledgerItem);
      if (!preFetchLedger.ok) {
        if (preFetchLedger.status === "error") {
          this.counts.nodeErrors += 1;
          this.emitLog(address, meetingId, "ledger_read_error");
          return {
            handled: true,
            httpStatus: 503,
            body: { error: "unavailable" },
            outcome: "node_error",
          };
        }
        this.counts.tombstoned += 1;
        this.emitLog(address, meetingId, "tombstoned", { reason: preFetchLedger.reason });
        return {
          handled: true,
          httpStatus: 200,
          body: { status: "ignored" },
          outcome: "tombstoned",
        };
      }

      // TC-3344 reset-aware replay dedupe.
      const resetMs = await this.effectiveResetMs(address);
      if (this.hasActiveReplayMarker(address, meetingId, resetMs)) {
        this.counts.alreadyPresent += 1;
        this.emitLog(address, meetingId, "already_present", { deduped: 1 });
        return {
          handled: true,
          httpStatus: 200,
          body: { status: "already_present" },
          outcome: "already_present",
        };
      }

      // Per-user spacing and global concurrency ceiling.
      if (this.perUserSpacingMs > 0) {
        const lastRun = this.lastRunAtByAddress.get(address);
        if (lastRun !== undefined) {
          const remaining = this.perUserSpacingMs - (this.nowFn() - lastRun);
          if (remaining > 0) await this.sleepImpl(remaining);
        }
      }

      const release = await this.semaphore.acquire();
      let scopedNode: TinyCloudNode | null = null;
      const ephemeral: { apiKey: string; fetched: FirefliesFetchResult | null } = {
        apiKey: "",
        fetched: null,
      };
      try {
        const startedAt = this.nowFn();
        setBoundedMap(this.lastRunAtByAddress, address, startedAt);
        scopedNode = this.delegate.createScopedNode();

        // Step 1a (G2): Validate the meetings write grant live at the node BEFORE reading G1 or
        // calling Fireflies so a revoked/refused G2 makes zero Fireflies calls.
        const g2Check = await this.checkMeetingsGrantImpl(scopedNode, verified);
        if (g2Check.status === "revoked") {
          await this.grantStore.markState(address, "revoked", null);
          this.counts.stoppedRevoked += 1;
          this.emitLog(address, meetingId, "stopped_revoked", { stage: "meetings_check" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "revoked" },
            outcome: "stopped_revoked",
          };
        }
        if (g2Check.status === "unauthorized") {
          await this.grantStore.markState(address, "needs_renewal", null);
          this.counts.stoppedNeedsRenewal += 1;
          this.emitLog(address, meetingId, "stopped_needs_renewal", { stage: "meetings_check" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "paused" },
            outcome: "stopped_needs_renewal",
          };
        }
        if (g2Check.status !== "ok") {
          this.counts.nodeErrors += 1;
          this.emitLog(address, meetingId, "node_error", { stage: "meetings_check" });
          return {
            handled: true,
            httpStatus: 503,
            body: { error: "unavailable" },
            outcome: "node_error",
          };
        }

        // Step 1b (G1): Read FIREFLIES_API_KEY into memory for this run only.
        const secret = await this.readSecretKeyImpl(scopedNode, verified);
        if (secret.status === "revoked") {
          await this.grantStore.markState(address, "revoked", null);
          this.counts.stoppedRevoked += 1;
          this.emitLog(address, meetingId, "stopped_revoked", { stage: "secret_read" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "revoked" },
            outcome: "stopped_revoked",
          };
        }
        if (secret.status === "unauthorized") {
          await this.grantStore.markState(address, "needs_renewal", null);
          this.counts.stoppedNeedsRenewal += 1;
          this.emitLog(address, meetingId, "stopped_needs_renewal", { stage: "secret_read" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "paused" },
            outcome: "stopped_needs_renewal",
          };
        }
        if (secret.status === "missing") {
          this.counts.missingSecret += 1;
          this.emitLog(address, meetingId, "missing_secret");
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "missing_secret" },
            outcome: "missing_secret",
          };
        }
        if (secret.status === "resave_required") {
          this.counts.resaveRequired += 1;
          this.emitLog(address, meetingId, "resave_required");
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "resave_required" },
            outcome: "resave_required",
          };
        }
        if (secret.status !== "ok") {
          this.counts.nodeErrors += 1;
          this.emitLog(address, meetingId, "node_error", { stage: "secret_read" });
          return {
            handled: true,
            httpStatus: 503,
            body: { error: "unavailable" },
            outcome: "node_error",
          };
        }

        ephemeral.apiKey = secret.value;

        // Step 2: Fetch meeting directly from Fireflies API; clear key immediately after.
        try {
          ephemeral.fetched = await this.fetchMeetingImpl(
            { meetingId, apiKey: ephemeral.apiKey },
            this.fetchOptions,
          );
        } finally {
          ephemeral.apiKey = "";
        }

        const fetched = ephemeral.fetched;
        if (!fetched.ok) {
          this.counts.firefliesErrors += 1;
          if (fetched.code === "redirect_refused") this.counts.redirectRefused += 1;
          if (fetched.code === "response_too_large") this.counts.responseTooLarge += 1;
          this.emitLog(address, meetingId, "fireflies_error", { code: fetched.code });
          return {
            handled: true,
            httpStatus: isRetryableFirefliesError(fetched.code) ? 503 : 200,
            body: isRetryableFirefliesError(fetched.code)
              ? { error: "unavailable" }
              : { status: "ignored" },
            outcome: "fireflies_error",
          };
        }

        // Step 3 (G2): Write straight to owner KV with ifNoneMatch: "*" (no SQL, no overwrite).
        // Each write re-checks the purge ledger inside `withConnectorConnectionChange` (the same
        // per-owner lane POST /purged uses) so a purge landing during fetch or between writes
        // prevents deleted meetings from coming back.
        let lastTombstoneReason = "tombstoned";
        const guardWrite: FirefliesWriteGuard = async (writeOp) =>
          withConnectorConnectionChange(address, async () => {
            const verdict = await this.checkPurgeLedger(address, ledgerItem);
            if (!verdict.ok) {
              if (verdict.status === "tombstoned") lastTombstoneReason = verdict.reason;
              return { guarded: false as const, status: verdict.status };
            }
            return { guarded: true as const, result: await writeOp() };
          });

        let writeResult: FirefliesMeetingWriteOutcome;
        if (this.customWriteMeetingImpl) {
          const guarded = await guardWrite(() =>
            this.customWriteMeetingImpl!(scopedNode!, verified, fetched.data),
          );
          writeResult = guarded.guarded ? guarded.result : { status: guarded.status };
        } else {
          writeResult = await defaultWriteMeeting(
            scopedNode,
            verified,
            fetched.data,
            this.configuredHost,
            guardWrite,
          );
        }

        if (writeResult.status === "tombstoned") {
          this.counts.tombstoned += 1;
          this.emitLog(address, meetingId, "tombstoned", {
            reason: lastTombstoneReason,
            stage: "pre_write",
          });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "ignored" },
            outcome: "tombstoned",
          };
        }
        if (writeResult.status === "revoked") {
          await this.grantStore.markState(address, "revoked", null);
          this.counts.stoppedRevoked += 1;
          this.emitLog(address, meetingId, "stopped_revoked", { stage: "kv_put" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "revoked" },
            outcome: "stopped_revoked",
          };
        }
        if (writeResult.status === "unauthorized") {
          await this.grantStore.markState(address, "needs_renewal", null);
          this.counts.stoppedNeedsRenewal += 1;
          this.emitLog(address, meetingId, "stopped_needs_renewal", { stage: "kv_put" });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "paused" },
            outcome: "stopped_needs_renewal",
          };
        }
        if (writeResult.status === "storage_full") {
          // TC-1192: never advance last_synced_at on a quota error.
          this.counts.storageFull += 1;
          this.emitLog(address, meetingId, "storage_full");
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "storage_full" },
            outcome: "storage_full",
          };
        }
        if (writeResult.status === "error") {
          this.counts.nodeErrors += 1;
          this.emitLog(address, meetingId, "node_error", { stage: "kv_put" });
          return {
            handled: true,
            httpStatus: 503,
            body: { error: "unavailable" },
            outcome: "node_error",
          };
        }

        const finishedAt = this.nowFn();
        const durationMs = Math.max(0, finishedAt - startedAt);
        const sentencesCount = fetched.data.sentences.length;
        const payloadBytes = fetched.data.bytes;
        this.markImported(address, meetingId, finishedAt);

        if (writeResult.status === "already_present") {
          this.counts.alreadyPresent += 1;
          this.emitLog(address, meetingId, "already_present", {
            duration_ms: durationMs,
          });
          return {
            handled: true,
            httpStatus: 200,
            body: { status: "already_present" },
            outcome: "already_present",
          };
        }

        const syncedIso = new Date(finishedAt).toISOString();
        setBoundedMap(this.lastSyncedAtByAddress, address, syncedIso);
        this.onSynced?.(address, syncedIso);
        this.counts.imported += 1;
        this.emitLog(address, meetingId, "imported", {
          sentences: sentencesCount,
          bytes: payloadBytes,
          duration_ms: durationMs,
        });
        return {
          handled: true,
          httpStatus: 200,
          body: { status: "imported" },
          outcome: "imported",
        };
      } finally {
        ephemeral.apiKey = "";
        ephemeral.fetched = null;
        if (scopedNode) evictDelegateNodeGrants(scopedNode);
        release();
      }
    });
  }
}
