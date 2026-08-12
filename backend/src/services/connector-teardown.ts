import {
  PURGE_RECENT_ID_CAP,
  type PurgeLedger,
  type PurgeLedgerRead,
} from "../routes/connector-webhooks.js";
import type { ClearResult } from "./connector-queue.js";
import type { ContentMeta } from "./content-store.js";
import type { CredentialRevokeResult } from "./credential-store.js";
import {
  isValidSource,
  keyedLogHash,
  normalizeWebhookAddress,
  redactedErrorMessage,
} from "./webhook-tokens.js";

/**
 * W7 — TEARDOWN + PURGE EXTENSION (backend-ingest plan §8.1 W7; §8.2 delta item 12;
 * §9 anti-pattern 8: "no teardown — secret/mapping/queue/delegation left behind").
 *
 * The DELETE-shaped disconnect for a COHORT address, in ONE idempotent call. Under the shipped
 * Option C a disconnect had two things to remove (the token/config and the queue) because the
 * backend held nothing else; the operator-authorized reversal (plan §11) gave it two more — a
 * live Fireflies credential and a server-side copy of the meetings — and both must leave with
 * the same click.
 *
 * THE ORDER IS THE DESIGN:
 *
 *  1. **The purge ledger first.** §6.2's `purgedThrough` watermark (+ `recentIds` for
 *     attribution) is written BEFORE anything is deleted. Fireflies is at-least-once and a
 *     timestamp-less delivery is replayable indefinitely (findings §2.1), so a teardown that
 *     deletes without a durable tombstone is a teardown a replay silently undoes: the content
 *     store re-creates the rows and the worker refetches them with whatever credential exists
 *     next. A failed ledger write therefore ABORTS — nothing is deleted — and the client retries
 *     the same idempotent call.
 *  2. **The credential.** Upstream OAuth revoke where the branch supports it, then the row,
 *     unconditionally (`CredentialStore.revoke`'s own posture: a provider outage must not leave
 *     us holding a live key). A FAILED upstream revoke is carried out in the result and surfaced
 *     by the route — never swallowed, because the provider-side grant may still be live.
 *  3. **The content.** Every row, the index and the blobs for that ONE tenant.
 *  4. **The queue.** Last, so a crash between 3 and 4 leaves work queued for a tenant whose
 *     content is already tombstoned — which the worker then drops — rather than the reverse.
 *
 * The ledger this writes is the SHIPPED one, read by `connector-drain`'s `isTombstoned` for the
 * browser path and (W7) by `ContentStore` for the server path: one watermark covers content and
 * credential both, and there is no second copy of the rule to drift.
 *
 * Nothing here logs or returns a credential, a meeting id or a raw address.
 */

export interface TeardownCredentialStore {
  revoke(source: string, address: string): Promise<CredentialRevokeResult>;
}

/** The two content verbs a teardown needs. No list-every-tenant surface exists to reach for. */
export interface TeardownContentStore {
  list(source: string, address: string): Promise<ContentMeta[]>;
  purge(source: string, address: string): Promise<{ removed: number }>;
}

export interface TeardownQueue {
  clear(source: string, address: string): Promise<ClearResult>;
}

/** The ledger slice — the same three methods the companions' `ConnectorControl` exposes. */
export interface TeardownControl {
  readLedger(source: string, address: string): Promise<PurgeLedgerRead>;
  writeLedger(
    source: string,
    address: string,
    ledger: PurgeLedger,
  ): Promise<void>;
  quarantineLedger(
    source: string,
    address: string,
    raw: unknown,
  ): Promise<void>;
}

export interface ConnectorTeardownDeps {
  credentials: TeardownCredentialStore;
  content: TeardownContentStore;
  queue: TeardownQueue;
  control: TeardownControl;
}

export interface ConnectorTeardownOptions {
  now?: () => number;
}

/** A disposition, never a payload: counts and outcomes only. */
export interface ConnectorTeardownResult {
  /** The credential row is gone. True even when there was none to begin with (idempotent). */
  deleted: boolean;
  upstreamRevoked: CredentialRevokeResult["upstreamRevoked"];
  /** A FIXED code from `CredentialStore`, never a provider message. */
  reason?: CredentialRevokeResult["reason"];
  contentRemoved: number;
  queueDropped: number;
  /** The §6.2 watermark in force after this teardown. */
  tombstonedThrough: string;
}

/** The one interface the route depends on, so a harness can substitute a double. */
export interface ConnectorTeardown {
  run(source: string, address: string): Promise<ConnectorTeardownResult>;
}

function hashed(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

function logTeardown(fields: string): void {
  console.log(`[connector-teardown] ${fields} t=${new Date().toISOString()}`);
}

function warnTeardown(fields: string): void {
  console.warn(`[connector-teardown] ${fields} t=${new Date().toISOString()}`);
}

export class ConnectorTeardownService implements ConnectorTeardown {
  private readonly now: () => number;

  constructor(
    private readonly deps: ConnectorTeardownDeps,
    options: ConnectorTeardownOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  async run(
    source: string,
    address: string,
  ): Promise<ConnectorTeardownResult> {
    if (!isValidSource(source)) throw new Error("Invalid connector source");
    const addr = normalizeWebhookAddress(address);

    // (1) The tombstone, first and durable.
    const tombstonedThrough = await this.recordPurge(source, addr);

    // (2) Custody ends. An upstream failure is a VALUE here, surfaced by the caller.
    const revoked = await this.deps.credentials.revoke(source, addr);

    // (3) Content. Sequential inside the store's own per-tenant lane.
    const { removed } = await this.deps.content.purge(source, addr);

    // (4) The queue — the count comes from the clear itself, never a `list()` a round trip
    // earlier (F010): anything enqueued in between would go uncounted and read as "nothing was
    // left behind" when something was.
    const { cleared } = await this.deps.queue.clear(source, addr);

    logTeardown(
      `op=teardown result=ok source=${source} aid=${hashed(addr)} ` +
        `credential_deleted=${revoked.deleted} upstream=${revoked.upstreamRevoked} ` +
        `content_removed=${removed} queue_dropped=${cleared} ` +
        `through=${tombstonedThrough}`,
    );

    return {
      deleted: revoked.deleted,
      upstreamRevoked: revoked.upstreamRevoked,
      ...(revoked.reason === undefined ? {} : { reason: revoked.reason }),
      contentRemoved: removed,
      queueDropped: cleared,
      tombstonedThrough,
    };
  }

  /**
   * §6.2's ledger, merged the way `POST …/purged` merges it: MONOTONIC watermark (a teardown
   * never moves it backwards) and `recentIds` capped at {@link PURGE_RECENT_ID_CAP}, newest
   * kept. The ids are attribution only — the watermark is what protects, which is why a content
   * index we cannot read is survivable here: the purge still lands, with fewer ids named.
   */
  private async recordPurge(source: string, address: string): Promise<string> {
    const read = await this.deps.control.readLedger(source, address);
    if (read.status === "unparseable") {
      // Never read as empty — that reading is "nothing was ever purged" (§6.2).
      await this.deps.control.quarantineLedger(source, address, read.raw);
      warnTeardown(
        `op=ledger-quarantine source=${source} aid=${hashed(address)}`,
      );
    }
    const existing = read.status === "ok" ? read.ledger : null;

    let ids: string[] = [];
    try {
      ids = (await this.deps.content.list(source, address)).map(
        (meta) => meta.sourceId,
      );
    } catch (error) {
      // Forensics degraded, protection intact: the watermark below tombstones a purge of any
      // size. Said out loud rather than reported as a complete attribution.
      warnTeardown(
        `op=teardown result=content_ids_unavailable source=${source} ` +
          `aid=${hashed(address)}`,
      );
      console.warn(
        "[connector-teardown] content index read failed:",
        redactedErrorMessage(error),
      );
    }

    const existingMs =
      existing === null
        ? Number.NEGATIVE_INFINITY
        : Date.parse(existing.purgedThrough);
    const throughMs = Math.max(
      Number.isFinite(existingMs) ? existingMs : Number.NEGATIVE_INFINITY,
      this.now(),
    );
    const purgedThrough = new Date(throughMs).toISOString();
    const recentIds = [...new Set([...(existing?.recentIds ?? []), ...ids])].slice(
      -PURGE_RECENT_ID_CAP,
    );

    await this.deps.control.writeLedger(source, address, {
      purgedThrough,
      recentIds,
      updatedAt: new Date(this.now()).toISOString(),
    });
    return purgedThrough;
  }
}
