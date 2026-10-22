import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { StoredDelegation } from "@tinyboilerplate/core";
import {
  assertKvResult,
  isKvMissingKeyResult,
  withSessionRefresh,
} from "./identity.js";

// ── Types ────────────────────────────────────────────────────────────

export interface DelegationMetadata {
  grantedAt?: string;
  expiresAt: string;
  actions: string[];
  path: string;
  policyHash?: string;
  delegateDid?: string;
  resources?: StoredDelegation["resources"];
}

/**
 * Binds a {@link DelegationStore} to one grant kind. Every record carries its `kind`, lives under
 * the kind's own `keyPrefix`, and is refused when it is read or written as a different kind.
 */
export interface DelegationGrantKind {
  /** Grant kind stored on every record and checked on every load. */
  kind: string;
  /** Envelope `format` this kind's serialized grants carry. Envelopes of another format are refused on store. */
  envelopeFormat: string;
  /** KV key prefix. Distinct per kind so one kind never reads or overwrites another kind's record. */
  keyPrefix: string;
  /** True only for the store whose records were written before `kind` existed. Those records read as this kind. */
  acceptsUnkindedRecords: boolean;
  /**
   * True when store() accepts only a JSON envelope whose `format` is exactly `envelopeFormat`.
   * False keeps the connector behavior: opaque strings are accepted and the route verifies them.
   */
  strictEnvelope: boolean;
}

/** Connector (transcript-writer) grants. Records written before `kind` existed live under this prefix. */
export const TRANSCRIPT_WRITER_GRANT_KIND: DelegationGrantKind = {
  kind: "transcript-writer",
  envelopeFormat: "tinychat.transcript-writer-grant",
  keyPrefix: "delegations/",
  acceptsUnkindedRecords: true,
  strictEnvelope: false,
};

/** Exo sync grants. Own key prefix so they never overwrite or read connector records. */
export const EXO_SYNC_GRANT_KIND: DelegationGrantKind = {
  kind: "exo-sync",
  envelopeFormat: "tinychat.exo-sync-grant",
  keyPrefix: "delegations/exo-sync/",
  acceptsUnkindedRecords: false,
  strictEnvelope: true,
};

// ── Delegation Store ─────────────────────────────────────────────────

/**
 * Persists and retrieves user delegations using the backend's own
 * TinyCloud KV store.
 *
 * Key format: `{grant.keyPrefix}{identifier}` in the backend's KV space.
 */
export class DelegationStore {
  constructor(
    private readonly node: TinyCloudNode,
    private readonly grant: DelegationGrantKind,
  ) {}

  /**
   * Store a serialized delegation for a user identifier.
   */
  async store(
    identifier: string,
    serialized: string,
    metadata: DelegationMetadata,
  ): Promise<void> {
    const key = this.keyFor(identifier);
    if (!this.isAcceptableEnvelope(serialized)) {
      throw new Error(`Delegation envelope is not a ${this.grant.kind} grant`);
    }
    const record: StoredDelegation = {
      kind: this.grant.kind,
      serialized,
      grantedAt: metadata.grantedAt ?? new Date().toISOString(),
      expiresAt: metadata.expiresAt,
      actions: metadata.actions,
      path: metadata.path,
      policyHash: metadata.policyHash,
      delegateDid: metadata.delegateDid,
      resources: metadata.resources,
    };

    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.put(key, record);
      assertKvResult(result);
    });
  }

  /**
   * Load the stored delegation for a user identifier.
   * Returns null if no delegation exists, or if the record is not of this store's kind.
   */
  async load(identifier: string): Promise<StoredDelegation | null> {
    const key = this.keyFor(identifier);

    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });

    const response = (result as any)?.data;
    if (!response) return null;

    try {
      // KV get returns { data: value } — unwrap it
      let raw = response.data ?? response;
      if (typeof raw === "string") raw = JSON.parse(raw);

      // Validate required StoredDelegation fields
      if (
        typeof raw !== "object" ||
        raw === null ||
        typeof raw.serialized !== "string" ||
        typeof raw.expiresAt !== "string" ||
        !Array.isArray(raw.actions)
      ) {
        console.warn(
          `[DelegationStore] Invalid delegation shape for ${identifier}:`,
          Object.keys(raw ?? {}),
        );
        return null;
      }

      const recordKind =
        raw.kind ?? (this.grant.acceptsUnkindedRecords ? this.grant.kind : undefined);
      if (recordKind !== this.grant.kind) {
        console.warn(
          `[DelegationStore] Delegation for ${identifier} is not a ${this.grant.kind} grant`,
        );
        return null;
      }

      return raw as StoredDelegation;
    } catch (err) {
      console.warn(
        `[DelegationStore] Failed to parse stored delegation for ${identifier}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Remove the stored delegation for a user identifier.
   */
  async remove(identifier: string): Promise<void> {
    const key = this.keyFor(identifier);

    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (isKvMissingKeyResult(result, key)) return;
      assertKvResult(result);
    });
  }

  /**
   * Check whether a stored delegation exists and is not expired.
   */
  async isActive(identifier: string): Promise<boolean> {
    const stored = await this.load(identifier);
    if (!stored) return false;
    return new Date(stored.expiresAt).getTime() > Date.now();
  }

  // Strict kinds accept only a JSON object whose format is this kind's format. Other kinds refuse
  // only envelopes that declare a different format; opaque strings pass to the route's verifier.
  private isAcceptableEnvelope(serialized: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      return !this.grant.strictEnvelope;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return !this.grant.strictEnvelope;
    }
    const declared = (parsed as { format?: unknown }).format;
    if (this.grant.strictEnvelope) {
      return declared === this.grant.envelopeFormat;
    }
    return !("format" in parsed) || declared === this.grant.envelopeFormat;
  }

  private keyFor(identifier: string): string {
    if (
      !identifier ||
      identifier.includes("/") ||
      identifier.includes("\\") ||
      identifier.includes("..")
    ) {
      throw new Error("Invalid delegation identifier");
    }
    return `${this.grant.keyPrefix}${identifier}`;
  }
}
