import { createHmac, hkdfSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  MEETING_ID_PATTERN,
  WEBHOOK_TOKEN_PATTERN,
  WebhookTokenService,
  _resetWebhookTokenState,
  assertStrongSecret,
  currentWebhookMaster,
  deriveWebhookSecret,
  deriveWebhookSecretWithMaster,
  generateWebhookToken,
  isValidMeetingId,
  isValidSource,
  isValidToken,
  keyedLogHash,
  previousWebhookMaster,
  recordSignatureKeyUse,
  redactedErrorMessage,
  verifyWebhookDelivery,
  webhookSigKeyCohort,
} from "../services/webhook-tokens.js";

const ORIGINAL_ENV = { ...process.env };

const MASTER_A = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef").toString(
  "base64",
);
const MASTER_B = Buffer.from("0123456789abcdef0123456789abcdef").toString(
  "base64",
);
const SALT = Buffer.from("log-salt-log-salt-log-salt-1234x").toString("base64");

const ADDRESS = "0x7d0333AbCdEf0123456789AbCdEf012345673f21";
const OTHER_ADDRESS = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.WEBHOOK_HMAC_MASTER = MASTER_A;
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
  process.env.LOG_HASH_SALT = SALT;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

// ── Fake backend-KV node ─────────────────────────────────────────────

class FakeNode {
  readonly store = new Map<string, unknown>();
  readonly calls: Array<{ op: string; key: string }> = [];
  maxConcurrent = 0;
  private inFlight = 0;
  failKey: string | null = null;
  /**
   * §2/4 hardening: a Result-shaped failure MUST NOT be silently accepted. When the predicate
   * matches the KV key, the fake returns `{ok:false, error:'kv_*_rejected'}` without throwing,
   * exactly as a real durable-write rejection would arrive across the SDK boundary.
   */
  failPutFor: ((key: string) => boolean) | null = null;
  failDeleteFor: ((key: string) => boolean) | null = null;
  /**
   * When set, kv.get resolves `{ok:false, error:'kv_read_rejected'}` for the matching key —
   * the exact shape the SDK now hands back for a durable read failure. Prior read helpers
   * cast `(result as {data?}).data` and read that as ABSENT, which is exactly the class of
   * silent open-fail the assertKvResult contract on the write path was meant to close on
   * the read path too.
   */
  failGetFor: ((key: string) => boolean) | null = null;

  readonly kv = {
    get: async (key: string): Promise<unknown> => {
      await this.enter("get", key);
      try {
        if (this.failGetFor?.(key)) {
          return { ok: false, error: "kv_read_rejected" };
        }
        if (!this.store.has(key)) return { data: null };
        return { data: { data: this.store.get(key) } };
      } finally {
        this.exit();
      }
    },
    put: async (key: string, value: unknown): Promise<unknown> => {
      await this.enter("put", key);
      try {
        if (this.failPutFor?.(key)) {
          return { ok: false, error: "kv_write_rejected" };
        }
        this.store.set(key, value);
        return { data: true };
      } finally {
        this.exit();
      }
    },
    delete: async (key: string): Promise<unknown> => {
      await this.enter("delete", key);
      try {
        if (this.failDeleteFor?.(key)) {
          return { ok: false, error: "kv_delete_rejected" };
        }
        this.store.delete(key);
        return { data: true };
      } finally {
        this.exit();
      }
    },
  };

  async signIn(): Promise<void> {}

  countCalls(op?: string): number {
    return op
      ? this.calls.filter((call) => call.op === op).length
      : this.calls.length;
  }

  private async enter(op: string, key: string): Promise<void> {
    this.calls.push({ op, key });
    this.inFlight += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.failKey !== null && key === this.failKey) {
      this.inFlight -= 1;
      throw new Error("node unreachable");
    }
  }

  private exit(): void {
    this.inFlight -= 1;
  }
}

function createService(
  options?: ConstructorParameters<typeof WebhookTokenService>[1],
) {
  const node = new FakeNode();
  const service = new WebhookTokenService(
    node as unknown as TinyCloudNode,
    options,
  );
  return { node, service };
}

// ── Identifier validation (§4.1 / §4.5) ──────────────────────────────

describe("isValidToken", () => {
  test("accepts exactly the 43-char base64url shape", () => {
    expect(WEBHOOK_TOKEN_PATTERN.source).toBe("^[A-Za-z0-9_-]{43}$");
    expect(isValidToken("a".repeat(43))).toBe(true);
    expect(isValidToken("A9_-".repeat(10) + "abc")).toBe(true);
  });

  test("rejects wrong lengths", () => {
    expect(isValidToken("a".repeat(42))).toBe(false);
    expect(isValidToken("a".repeat(44))).toBe(false);
    expect(isValidToken("")).toBe(false);
  });

  test("rejects traversal in every form Express can produce", () => {
    // Express percent-decodes route params, so these are the DECODED values that arrive.
    expect(isValidToken("../../delegations/0xabc")).toBe(false);
    expect(isValidToken("..%2F..%2Fdelegations%2F0xabc")).toBe(false);
    expect(isValidToken("..".padEnd(43, "a"))).toBe(false);
    expect(isValidToken("a".repeat(21) + "/" + "a".repeat(21))).toBe(false);
    expect(isValidToken("a".repeat(21) + "\\" + "a".repeat(21))).toBe(false);
    expect(isValidToken("a".repeat(21) + "%" + "a".repeat(21))).toBe(false);
    expect(isValidToken("a".repeat(21) + "." + "a".repeat(21))).toBe(false);
  });

  test("rejects base64 (non-url) padding characters and non-strings", () => {
    expect(isValidToken("a".repeat(42) + "=")).toBe(false);
    expect(isValidToken("a".repeat(42) + "+")).toBe(false);
    expect(isValidToken("a".repeat(42) + "/")).toBe(false);
    expect(isValidToken(undefined)).toBe(false);
    expect(isValidToken(null)).toBe(false);
    expect(isValidToken(43)).toBe(false);
  });
});

describe("isValidMeetingId", () => {
  test("accepts ULID-ish ids up to 64 chars", () => {
    expect(MEETING_ID_PATTERN.source).toBe("^[A-Za-z0-9_-]{1,64}$");
    expect(isValidMeetingId("01J8ZKQ4V9XW2N")).toBe(true);
    expect(isValidMeetingId("a")).toBe(true);
    expect(isValidMeetingId("a".repeat(64))).toBe(true);
  });

  test("rejects empty, oversize, traversal and encoded forms", () => {
    expect(isValidMeetingId("")).toBe(false);
    expect(isValidMeetingId("a".repeat(65))).toBe(false);
    expect(isValidMeetingId("a".repeat(60_000))).toBe(false);
    expect(isValidMeetingId("../../threads/x")).toBe(false);
    expect(isValidMeetingId("..%2F..%2Fthreads%2Fx")).toBe(false);
    expect(isValidMeetingId("a/b")).toBe(false);
    expect(isValidMeetingId("a\\b")).toBe(false);
    expect(isValidMeetingId(12345)).toBe(false);
  });
});

describe("generateWebhookToken", () => {
  test("produces tokens that pass the same isValidToken used on lookup", () => {
    for (let i = 0; i < 50; i += 1) {
      const token = generateWebhookToken();
      expect(token).toHaveLength(43);
      expect(isValidToken(token)).toBe(true);
    }
  });

  test("tokens are unique", () => {
    const tokens = new Set(
      Array.from({ length: 200 }, () => generateWebhookToken()),
    );
    expect(tokens.size).toBe(200);
  });
});

describe("isValidSource", () => {
  test("accepts registry ids and rejects path input", () => {
    expect(isValidSource("fireflies")).toBe(true);
    expect(isValidSource("google-meet")).toBe(true);
    expect(isValidSource("Fireflies")).toBe(false);
    expect(isValidSource("../fireflies")).toBe(false);
    expect(isValidSource("")).toBe(false);
  });
});

// ── Strength gate (§7.1 / §4.2) ──────────────────────────────────────

describe("assertStrongSecret", () => {
  test("accepts the two documented generation paths", () => {
    expect(assertStrongSecret("X", MASTER_A, { quiet: true })).toBe(32);
    expect(assertStrongSecret("X", "a1b2c3d4".repeat(8), { quiet: true })).toBe(
      32,
    );
    expect(
      assertStrongSecret("X", Buffer.alloc(32, 7).toString("base64url"), {
        quiet: true,
      }),
    ).toBe(32);
  });

  test("rejects a missing value", () => {
    expect(() =>
      assertStrongSecret("WEBHOOK_HMAC_MASTER", undefined, { quiet: true }),
    ).toThrow(/WEBHOOK_HMAC_MASTER is missing or too weak/);
    expect(() =>
      assertStrongSecret("WEBHOOK_HMAC_MASTER", "   ", { quiet: true }),
    ).toThrow();
  });

  test("rejects anything decoding to fewer than 32 bytes", () => {
    expect(() =>
      assertStrongSecret("X", "a1b2c3d4".repeat(4), { quiet: true }),
    ).toThrow(/need >=32 decoded bytes/);
    expect(() =>
      assertStrongSecret("X", Buffer.alloc(31, 9).toString("base64"), {
        quiet: true,
      }),
    ).toThrow();
    expect(() => assertStrongSecret("X", "short", { quiet: true })).toThrow();
  });

  test("rejects every placeholder on the deny-list", () => {
    for (const placeholder of [
      "changeme",
      "CHANGEME",
      "change-me",
      "secret",
      "test",
      "placeholder",
      "changeme-changeme-changeme-changeme",
      "replace-me-with-a-real-secret-value",
      "generate-with-openssl-rand-base64-32",
      "a".repeat(64),
      "0".repeat(80),
    ]) {
      expect(() =>
        assertStrongSecret("X", placeholder, { quiet: true }),
      ).toThrow();
    }
  });

  test("optional accepts absence but still gates a present value", () => {
    expect(
      assertStrongSecret("X", undefined, { optional: true, quiet: true }),
    ).toBeNull();
    expect(
      assertStrongSecret("X", "", { optional: true, quiet: true }),
    ).toBeNull();
    expect(() =>
      assertStrongSecret("X", "weak", { optional: true, quiet: true }),
    ).toThrow();
  });

  test("logs the accepted LENGTH and never the value", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      assertStrongSecret("WEBHOOK_HMAC_MASTER", MASTER_A);
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(
      "WEBHOOK_HMAC_MASTER accepted (32 decoded bytes)",
    );
    expect(lines[0]).not.toContain(MASTER_A);
  });
});

describe("master accessors", () => {
  test("currentWebhookMaster refuses a missing or weak master instead of falling back", () => {
    delete process.env.WEBHOOK_HMAC_MASTER;
    expect(() => currentWebhookMaster()).toThrow(/WEBHOOK_HMAC_MASTER/);
    process.env.WEBHOOK_HMAC_MASTER = "changeme";
    expect(() => currentWebhookMaster()).toThrow();
    process.env.WEBHOOK_HMAC_MASTER = MASTER_A;
    expect(currentWebhookMaster()).toBe(MASTER_A);
  });

  test("previousWebhookMaster is null when unset and gated when present", () => {
    expect(previousWebhookMaster()).toBeNull();
    process.env.WEBHOOK_HMAC_MASTER_PREV = "too-short";
    expect(() => previousWebhookMaster()).toThrow();
    process.env.WEBHOOK_HMAC_MASTER_PREV = MASTER_B;
    expect(previousWebhookMaster()).toBe(MASTER_B);
  });
});

// ── HKDF derivation (§4.2) ───────────────────────────────────────────

describe("deriveWebhookSecret", () => {
  const token = generateWebhookToken();

  test("is stable across calls", () => {
    expect(deriveWebhookSecret("fireflies", token)).toBe(
      deriveWebhookSecret("fireflies", token),
    );
  });

  /**
   * V-b amendment (backend-ingest DECISIONS): Fireflies' secret field accepts 16-32 characters,
   * so the derivation now emits 24 bytes = exactly 32 base64url chars. The bounds themselves,
   * the one-scheme property and the legacy compatibility arm live in
   * `webhook-secret-length.test.ts`.
   */
  test("is a 24-byte base64url value — 32 chars, inside the provider's field bounds", () => {
    const secret = deriveWebhookSecret("fireflies", token);
    expect(secret).toHaveLength(32);
    expect(Buffer.from(secret, "base64url")).toHaveLength(24);
  });

  test("is info-bound to BOTH the source and the token", () => {
    const other = generateWebhookToken();
    expect(deriveWebhookSecret("fireflies", token)).not.toBe(
      deriveWebhookSecret("granola", token),
    );
    expect(deriveWebhookSecret("fireflies", token)).not.toBe(
      deriveWebhookSecret("fireflies", other),
    );
  });

  test("is master-bound", () => {
    const withA = deriveWebhookSecretWithMaster("fireflies", token, MASTER_A);
    const withB = deriveWebhookSecretWithMaster("fireflies", token, MASTER_B);
    expect(withA).not.toBe(withB);
  });

  test("refuses to derive for an invalid token or source", () => {
    expect(() => deriveWebhookSecret("fireflies", "../../x")).toThrow(
      /invalid token/,
    );
    expect(() => deriveWebhookSecret("../x", token)).toThrow(/invalid source/);
  });

  test("matches the documented HKDF construction exactly", () => {
    const expected = Buffer.from(
      hkdfSync(
        "sha256",
        MASTER_A,
        "tinychat-webhook-v1",
        `fireflies:${token}`,
        24,
      ),
    ).toString("base64url");
    expect(deriveWebhookSecret("fireflies", token)).toBe(expected);
  });
});

// ── Rotation: _PREV acceptance + sig_key reporting (§4.2 / §7.6) ─────

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWebhookDelivery", () => {
  const token = generateWebhookToken();
  const body = Buffer.from(
    JSON.stringify({ meeting_id: "01J8ZK", event: "meeting.transcribed" }),
  );

  test("reports sig_key=current for a delivery under the live master", () => {
    const header = sign(
      body,
      deriveWebhookSecretWithMaster("fireflies", token, MASTER_A),
    );
    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: header,
        source: "fireflies",
        token,
      }),
    ).toEqual({ verified: true, sigKey: "current", secretForm: "current" });
  });

  test("accepts the PREV master during rotation and reports sig_key=prev", () => {
    const oldSecretHeader = sign(
      body,
      deriveWebhookSecretWithMaster("fireflies", token, MASTER_A),
    );
    // Rotate: A becomes _PREV, B becomes current.
    process.env.WEBHOOK_HMAC_MASTER = MASTER_B;
    process.env.WEBHOOK_HMAC_MASTER_PREV = MASTER_A;

    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: oldSecretHeader,
        source: "fireflies",
        token,
      }),
    ).toEqual({ verified: true, sigKey: "prev", secretForm: "current" });
  });

  test("rejects the old master once _PREV is dropped", () => {
    const oldSecretHeader = sign(
      body,
      deriveWebhookSecretWithMaster("fireflies", token, MASTER_A),
    );
    process.env.WEBHOOK_HMAC_MASTER = MASTER_B;
    delete process.env.WEBHOOK_HMAC_MASTER_PREV;

    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: oldSecretHeader,
        source: "fireflies",
        token,
      }),
    ).toEqual({ verified: false, sigKey: null, secretForm: null });
  });

  test("rejects a bad signature, a malformed token and a malformed source", () => {
    const junk = `sha256=${"b".repeat(64)}`;
    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: junk,
        source: "fireflies",
        token,
      }),
    ).toEqual({ verified: false, sigKey: null, secretForm: null });
    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: junk,
        source: "fireflies",
        token: "../../x",
      }),
    ).toEqual({ verified: false, sigKey: null, secretForm: null });
    expect(
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: junk,
        source: "../x",
        token,
      }),
    ).toEqual({ verified: false, sigKey: null, secretForm: null });
  });

  test("a non-ASCII header is a rejection, not a throw, through the rotation path too", () => {
    process.env.WEBHOOK_HMAC_MASTER_PREV = MASTER_B;
    const hostile = "sha256=" + "Ã" + "a".repeat(63);
    expect(() =>
      verifyWebhookDelivery({
        rawBody: body,
        signatureHeader: hostile,
        source: "fireflies",
        token,
      }),
    ).not.toThrow();
  });
});

describe("rotation cohort counter", () => {
  test("counts addresses still verifying under _PREV", () => {
    expect(webhookSigKeyCohort()).toEqual({ current: 0, prev: 0, total: 0 });

    recordSignatureKeyUse(ADDRESS, "prev");
    recordSignatureKeyUse(OTHER_ADDRESS, "prev");
    expect(webhookSigKeyCohort()).toEqual({ current: 0, prev: 2, total: 2 });

    // The migration metric drains as users re-paste.
    recordSignatureKeyUse(ADDRESS, "current");
    expect(webhookSigKeyCohort()).toEqual({ current: 1, prev: 1, total: 2 });

    recordSignatureKeyUse(OTHER_ADDRESS, "current");
    expect(webhookSigKeyCohort()).toEqual({ current: 2, prev: 0, total: 2 });
  });

  test("logs the transition without a raw address", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      recordSignatureKeyUse(ADDRESS, "prev");
      recordSignatureKeyUse(ADDRESS, "prev"); // steady state — no second line
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("sig_key=prev");
    expect(lines[0]).toContain("prev_cohort=1");
    expect(lines[0]).not.toContain(ADDRESS);
    expect(lines[0]).not.toContain(ADDRESS.toLowerCase());
    expect(lines[0]).not.toContain(ADDRESS.slice(2, 8));
  });
});

describe("keyedLogHash", () => {
  test("is >=16 hex chars, salt-keyed, and not derived from the HMAC master", () => {
    const hashed = keyedLogHash(ADDRESS.toLowerCase());
    expect(hashed).toMatch(/^[0-9a-f]{16}$/);
    expect(hashed).not.toContain(ADDRESS.slice(2, 8).toLowerCase());

    process.env.LOG_HASH_SALT = Buffer.from(
      "another-salt-another-salt-1234xy",
    ).toString("base64");
    expect(keyedLogHash(ADDRESS.toLowerCase())).not.toBe(hashed);
  });

  test("throws rather than silently emitting an unsalted hash", () => {
    delete process.env.LOG_HASH_SALT;
    expect(() => keyedLogHash("anything")).toThrow(/LOG_HASH_SALT/);
  });
});

// ── Token store + cache (§4.1 / §4.4) ────────────────────────────────

describe("WebhookTokenService", () => {
  test("mint writes both the token key and the reverse index, verbatim per §4.1", async () => {
    const { node, service } = createService();
    const { token, record } = await service.mint(ADDRESS, "fireflies");

    expect(isValidToken(token)).toBe(true);
    expect(record.address).toBe(ADDRESS.toLowerCase());
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(true);
    expect(
      node.store.get(`webhooks/config/${ADDRESS.toLowerCase()}`),
    ).toMatchObject({
      token,
      source: "fireflies",
    });
  });

  test("lookup resolves a minted token and exposes the owner address", async () => {
    const { service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    service.evictAll();

    const record = await service.lookup(token);
    expect(record?.address).toBe(ADDRESS.toLowerCase());
    expect(record?.source).toBe("fireflies");
  });

  test("a malformed token makes ZERO KV calls — the traversal guard is the amplification guard", async () => {
    const { node, service } = createService();
    for (const bad of [
      "../../delegations/0xabc",
      "a".repeat(44),
      "abcd",
      "",
      "a".repeat(21) + "/" + "a".repeat(21),
    ]) {
      expect(await service.lookup(bad)).toBeNull();
    }
    expect(node.countCalls()).toBe(0);
  });

  test("the positive cache removes the amplified round trip", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    const afterMint = node.countCalls("get");

    await service.lookup(token);
    await service.lookup(token);
    await service.lookup(token);
    expect(node.countCalls("get")).toBe(afterMint);
    expect(service.cacheStats()).toEqual({ positive: 1, negative: 0 });
  });

  test("the negative cache bounds unknown-token traffic", async () => {
    const { node, service } = createService();
    const unknown = generateWebhookToken();

    expect(await service.lookup(unknown)).toBeNull();
    expect(node.countCalls("get")).toBe(1);
    expect(await service.lookup(unknown)).toBeNull();
    expect(node.countCalls("get")).toBe(1);
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 1 });
  });

  test("a KV failure propagates and is NEVER negative-cached", async () => {
    const { node, service } = createService();
    const token = generateWebhookToken();
    node.failKey = `webhooks/tokens/${token}`;

    await expect(service.lookup(token)).rejects.toThrow(/node unreachable/);
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });

    node.failKey = null;
    expect(await service.lookup(token)).toBeNull();
  });

  test("an unparseable stored record is a miss, not a half-trusted record", async () => {
    const { node, service } = createService();
    const token = generateWebhookToken();
    node.store.set(`webhooks/tokens/${token}`, {
      address: "not-an-address",
      source: "fireflies",
    });

    expect(await service.lookup(token)).toBeNull();
  });

  test("rotation deletes the old key AND evicts it from the cache immediately", async () => {
    const { node, service } = createService();
    const first = await service.mint(ADDRESS, "fireflies");
    // Warm the positive cache — this is the state that makes deletion alone insufficient.
    expect(await service.lookup(first.token)).not.toBeNull();

    const second = await service.rotate(ADDRESS, "fireflies");
    expect(second.token).not.toBe(first.token);
    expect(second.rotatedFrom).toBe(first.token);
    expect(second.record.rotatedFrom).toBe(first.token);

    expect(node.store.has(`webhooks/tokens/${first.token}`)).toBe(false);
    expect(await service.lookup(first.token)).toBeNull();
    expect((await service.lookup(second.token))?.address).toBe(
      ADDRESS.toLowerCase(),
    );
    expect((await service.config(ADDRESS))?.token).toBe(second.token);
  });

  test("rotation keeps the old config and credential usable when revoking the old token fails, then a retry converges", async () => {
    const { node, service } = createService();
    const first = await service.mint(ADDRESS, "fireflies");
    expect(await service.lookup(first.token)).not.toBeNull();

    const oldTokenKey = `webhooks/tokens/${first.token}`;
    const originalDelete = node.kv.delete.bind(node.kv);
    let rejectOldDelete = true;
    node.kv.delete = async (key: string) => {
      if (rejectOldDelete && key === oldTokenKey) {
        return {
          ok: false,
          error: {
            code: "DELETE_REJECTED",
            message: "PRIVATE_RESULT_PAYLOAD old-token delete failed",
            service: "kv",
            meta: { status: 503 },
          },
        };
      }
      return originalDelete(key);
    };

    let rejection: unknown;
    try {
      await service.rotate(ADDRESS, "fireflies");
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toMatchObject({
      name: "KvResultError",
      code: "DELETE_REJECTED",
      status: 503,
    });
    expect((rejection as Error).message).toBe(
      "KV operation failed: code=DELETE_REJECTED status=503",
    );
    expect((rejection as Error).message).not.toContain(
      "PRIVATE_RESULT_PAYLOAD",
    );
    expect((await service.config(ADDRESS))?.token).toBe(first.token);
    expect(node.store.has(oldTokenKey)).toBe(true);
    expect((await service.lookup(first.token))?.address).toBe(
      ADDRESS.toLowerCase(),
    );

    rejectOldDelete = false;
    const retried = await service.rotate(ADDRESS, "fireflies");
    expect((await service.config(ADDRESS))?.token).toBe(retried.token);
    expect((await service.lookup(retried.token))?.address).toBe(
      ADDRESS.toLowerCase(),
    );
    expect(node.store.has(oldTokenKey)).toBe(false);
    expect(service.cacheStats()).toEqual({ positive: 1, negative: 0 });
    expect(await service.lookup(first.token)).toBeNull();
  });

  test("a config-write failure after old-token deletion fails closed and retries through an exact missing-key delete", async () => {
    const { node, service } = createService();
    const first = await service.mint(ADDRESS, "fireflies");
    expect(await service.lookup(first.token)).not.toBeNull();

    const oldTokenKey = `webhooks/tokens/${first.token}`;
    const configKey = `webhooks/config/${ADDRESS.toLowerCase()}`;
    const originalPut = node.kv.put.bind(node.kv);
    const originalDelete = node.kv.delete.bind(node.kv);
    let rejectConfigWrite = true;
    node.kv.put = async (key: string, value: unknown) => {
      if (rejectConfigWrite && key === configKey) {
        return {
          ok: false,
          error: {
            code: "CONFIG_WRITE_REJECTED",
            message: "PRIVATE_RESULT_PAYLOAD config write failed",
            service: "kv",
            meta: { status: 503 },
          },
        };
      }
      return originalPut(key, value);
    };
    node.kv.delete = async (key: string) => {
      if (key === oldTokenKey && !node.store.has(key)) {
        return {
          ok: false,
          error: {
            code: "KV_NOT_FOUND",
            message: `Key not found: ${key}`,
            service: "kv",
          },
        };
      }
      return originalDelete(key);
    };

    await expect(service.rotate(ADDRESS, "fireflies")).rejects.toMatchObject({
      name: "KvResultError",
      code: "CONFIG_WRITE_REJECTED",
      status: 503,
    });
    expect((await service.config(ADDRESS))?.token).toBe(first.token);
    expect(node.store.has(oldTokenKey)).toBe(false);
    expect(await service.lookup(first.token)).toBeNull();

    rejectConfigWrite = false;
    const retried = await service.rotate(ADDRESS, "fireflies");
    expect((await service.config(ADDRESS))?.token).toBe(retried.token);
    expect((await service.lookup(retried.token))?.address).toBe(
      ADDRESS.toLowerCase(),
    );
    expect(service.cacheStats()).toEqual({ positive: 1, negative: 0 });
    expect(await service.lookup(first.token)).toBeNull();
  });

  test("revoke is idempotent and removes both keys", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");

    await service.revoke(ADDRESS);
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      false,
    );
    expect(await service.lookup(token)).toBeNull();
    expect(await service.config(ADDRESS)).toBeNull();

    await service.revoke(ADDRESS);
    expect(await service.config(ADDRESS)).toBeNull();
  });

  // A revoke keyed only off a fully-valid config record deletes the config key and leaves the
  // TOKEN key alive: the public route checks token→address and never the disabled marker, so it
  // keeps answering 202 for a user who revoked, while the teardown answered 200 disabled.
  test("revoke recovers the token from a config record whose other fields are corrupt", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    node.store.set(`webhooks/config/${ADDRESS.toLowerCase()}`, {
      token,
      source: "not-a-source",
    });

    await service.revoke(ADDRESS);

    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      false,
    );
    service.evictAll();
    expect(await service.lookup(token)).toBeNull();
  });

  test("revoke fails loudly rather than reporting a clean teardown it did not do", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    node.store.set(`webhooks/config/${ADDRESS.toLowerCase()}`, {
      token: "not-a-valid-token",
    });

    await expect(service.revoke(ADDRESS)).rejects.toThrow(/unparseable/i);

    // …but NOT before deleting the live token best-effort. Leaving it was the failure this
    // branch exists to prevent, reached through the branch meant to prevent it: the route has
    // already written the durable disabled marker, so it answers 503 `teardown_incomplete`, the
    // client retries the same idempotent call and it throws again, permanently — while the
    // public handler (token→address, never the marker) keeps returning 202 for a revoked
    // account and consuming the shared node's write budget indefinitely.
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
    expect(await service.lookup(token)).toBeNull();
    // The config key IS left for an operator — it is the unreadable value, and the loud failure
    // is what surfaces it.
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      true,
    );
  });

  test("that branch fails with its OWN error even without LOG_HASH_SALT", async () => {
    // The `aid=` interpolation here called `keyedLogHash` bare, unlike every peer call site
    // (`hashed()`/`hashedField()` fall back to "unavailable"). With the salt absent the branch
    // threw a TypeError out of its own LOG LINE rather than the intended "refusing to report a
    // clean revoke" — from the logger, before the branch could finish. A branch should fail for
    // its own reason.
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    node.store.set(`webhooks/config/${ADDRESS.toLowerCase()}`, {
      token: "not-a-valid-token",
    });
    delete process.env.LOG_HASH_SALT;

    await expect(service.revoke(ADDRESS)).rejects.toThrow(/unparseable/i);
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
  });

  test("storage calls are sequential — never concurrent on one space (§9.3)", async () => {
    const { node, service } = createService();
    const addresses = Array.from({ length: 5 }, (_, i) =>
      `0x${String(i + 1).repeat(40)}`.slice(0, 42),
    );
    await Promise.all(
      addresses.map((address) => service.mint(address, "fireflies")),
    );
    expect(node.maxConcurrent).toBe(1);
  });

  test("rejects a malformed address rather than building a traversing key", async () => {
    const { node, service } = createService();
    await expect(
      service.mint("../../delegations/0xabc", "fireflies"),
    ).rejects.toThrow(/Invalid webhook config address/);
    await expect(service.mint(ADDRESS, "../fireflies")).rejects.toThrow(
      /Invalid webhook source/,
    );
    expect(node.countCalls()).toBe(0);
  });

  test("the positive cache expires", async () => {
    const { node, service } = createService({ positiveTtlMs: 1 });
    const { token } = await service.mint(ADDRESS, "fireflies");
    const afterMint = node.countCalls("get");

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await service.lookup(token))?.address).toBe(ADDRESS.toLowerCase());
    expect(node.countCalls("get")).toBe(afterMint + 1);
  });

  // ── KV hardening 2/4: durable writes must fail loudly (Result contract) ──
  //
  // A `{ok:false}` from `kv.put`/`kv.delete` is a durable-write REJECTION, not a success —
  // silently awaiting it lets `mint`/`rotate`/`revoke` return a token that was never
  // persisted and a config the reverse index never learned about. The public route then
  // resolves the token to NO owner (401 for the user who just enabled) while the UI shows
  // "enabled" with a live-looking secret. Same class as the revoke branch above: a fake
  // clean write.

  test("mint REJECTS when the token-key put returns ok:false — no keys written, no cache entry", async () => {
    const { node, service } = createService();
    node.failPutFor = (key) => key.startsWith("webhooks/tokens/");

    await expect(service.mint(ADDRESS, "fireflies")).rejects.toThrow(
      "KV operation failed",
    );
    // Nothing was persisted — the token key never landed and the config key was never attempted.
    expect([...node.store.keys()]).toEqual([]);
    // The service must NOT hand out a positive cache entry for a token it never persisted.
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });
  });

  test("mint REJECTS when the config-key put returns ok:false — the failure surfaces", async () => {
    const { node, service } = createService();
    node.failPutFor = (key) => key.startsWith("webhooks/config/");

    await expect(service.mint(ADDRESS, "fireflies")).rejects.toThrow(
      "KV operation failed",
    );
    // The token key WAS written (§4.1 order: token before config, so a crash leaves a working
    // config-less token). What must NOT happen is the caller believing the mint succeeded.
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });
  });

  test("rotate REJECTS when the new token-key put returns ok:false — old config is untouched", async () => {
    const { node, service } = createService();
    const first = await service.mint(ADDRESS, "fireflies");
    node.failPutFor = (key) => key.startsWith("webhooks/tokens/");

    await expect(service.rotate(ADDRESS, "fireflies")).rejects.toThrow(
      "KV operation failed",
    );
    // The old token/config record must survive a failed rotate — the user still has a working
    // webhook, and the operator can retry.
    expect(node.store.has(`webhooks/tokens/${first.token}`)).toBe(true);
    expect((await service.config(ADDRESS))?.token).toBe(first.token);
  });

  test("revoke REJECTS when deleteKey(tokenKey) returns ok:false — the config key stays for the operator", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    node.failDeleteFor = (key) => key === `webhooks/tokens/${token}`;

    await expect(service.revoke(ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
    // The token is still resolvable — revoke() reporting success while the token remains live
    // is exactly the class of failure this hardening exists to prevent.
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(true);
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      true,
    );
  });

  test("revoke REJECTS when deleteKey(configKey) returns ok:false", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    node.failDeleteFor = (key) =>
      key === `webhooks/config/${ADDRESS.toLowerCase()}`;

    await expect(service.revoke(ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
    // The token key was cleaned up first (order matters — the live token is the higher-risk key);
    // the config key remains as the unwritten-teardown signal for the operator.
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      true,
    );
  });

  // ── Session-refresh contract must survive Result-shaped session failures ──
  //
  // The audit's blocker: with the assertion placed OUTSIDE withSessionRefresh, a Result
  // carrying `{ok:false, error:"session expired"}` resolves the wrapper normally and the
  // caller throws AFTER, so the single-refresh retry path in `withSessionRefresh` never
  // observes the error. The assertion must live inside the callback and interpolate the
  // SDK error text so SESSION_ERROR_PATTERN matches — identical shape to
  // packages/server/src/__tests__/delegation-store.test.ts:260-275.

  test("mint takes the sign-in-and-retry path when the first kv.put returns a session-class Result", async () => {
    const { node, service } = createService();
    let signInCalls = 0;
    node.signIn = async () => {
      signInCalls += 1;
    };

    const originalPut = node.kv.put.bind(node.kv);
    let putCalls = 0;
    node.kv.put = async (key: string, value: unknown) => {
      putCalls += 1;
      if (putCalls === 1) return { ok: false, error: "session expired" };
      return originalPut(key, value);
    };

    await expect(service.mint(ADDRESS, "fireflies")).resolves.toBeDefined();

    expect(signInCalls).toBe(1);
    expect(putCalls).toBeGreaterThanOrEqual(2);
  });

  test("revoke takes the sign-in-and-retry path when the first kv.delete returns a session-class Result", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");

    let signInCalls = 0;
    node.signIn = async () => {
      signInCalls += 1;
    };

    const originalDelete = node.kv.delete.bind(node.kv);
    let deleteCalls = 0;
    node.kv.delete = async (key: string) => {
      deleteCalls += 1;
      if (deleteCalls === 1) return { ok: false, error: "session expired" };
      return originalDelete(key);
    };

    await expect(service.revoke(ADDRESS)).resolves.toBeUndefined();

    expect(signInCalls).toBe(1);
    expect(deleteCalls).toBeGreaterThanOrEqual(2);
    expect(node.store.has(`webhooks/tokens/${token}`)).toBe(false);
    expect(node.store.has(`webhooks/config/${ADDRESS.toLowerCase()}`)).toBe(
      false,
    );
  });

  test("structured key-missing reads are optional absences, including the negative cache", async () => {
    const { node, service } = createService();
    const token = generateWebhookToken();
    const key = `webhooks/tokens/${token}`;
    const requestedKeys: string[] = [];
    node.kv.get = async (requested: string) => {
      requestedKeys.push(requested);
      return {
        ok: false,
        error: {
          code: "KV_NOT_FOUND",
          message: `Key not found: ${requested}`,
          service: "kv",
        },
      };
    };

    await expect(service.lookup(token)).resolves.toBeNull();
    expect(requestedKeys).toEqual([key]);
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 1 });
  });

  test("structured key-missing config reads and deletes keep revoke idempotent", async () => {
    const { node, service } = createService();
    const key = `webhooks/config/${ADDRESS.toLowerCase()}`;
    const deleted: string[] = [];
    node.kv.get = async (requested: string) => ({
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: `Key not found: ${requested}`,
        service: "kv",
      },
    });
    node.kv.delete = async (requested: string) => {
      deleted.push(requested);
      return {
        ok: false,
        error: {
          code: "KV_NOT_FOUND",
          message: `Key not found: ${requested}`,
          service: "kv",
        },
      };
    };

    await expect(service.config(ADDRESS)).resolves.toBeNull();
    await expect(service.revoke(ADDRESS)).resolves.toBeUndefined();
    expect(deleted).toEqual([key]);
    expect(node.store.size).toBe(0);
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });
  });

  test("Space-not-found lookup fails closed and never enters the negative cache", async () => {
    const { node, service } = createService();
    const token = generateWebhookToken();
    node.kv.get = async () => ({
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: "KV 404 - Space not found",
        service: "kv",
        meta: { status: 404 },
      },
    });

    await expect(service.lookup(token)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    expect(node.store.size).toBe(0);
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });
  });

  test("Space-not-found delete fails closed without evicting or mutating durable token state", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    const before = new Map(node.store);
    node.kv.delete = async () => ({
      ok: false,
      error: {
        code: "KV_NOT_FOUND",
        message: "KV 404 - Space not found",
        service: "kv",
        meta: { status: 404 },
      },
    });

    await expect(service.revoke(ADDRESS)).rejects.toMatchObject({
      code: "KV_NOT_FOUND",
    });
    expect(node.store).toEqual(before);
    expect(service.cacheStats()).toEqual({ positive: 1, negative: 0 });
    expect(await service.lookup(token)).not.toBeNull();
  });
});

// ── End-to-end: rotation evicts, so a delivery on the old token 401s ──
//
// A minimal app carrying only the raw parser and a handler composed from W1's primitives
// (the shape W3 mounts for real). Deleting the KV key alone does not revoke: without the
// cache eviction the old token still resolves and its HKDF secret still verifies (§4.4).

function createApp(service: WebhookTokenService) {
  const app = express();
  app.post(
    "/api/connectors/webhooks/:source/:token",
    express.raw({ type: "application/json", limit: "64kb", inflate: false }),
    async (req, res) => {
      try {
        const { source, token } = req.params;
        if (!isValidSource(source) || !isValidToken(token)) {
          res.status(401).json({ error: "invalid_signature" });
          return;
        }
        const record = await service.lookup(token);
        if (!record || record.source !== source) {
          res.status(401).json({ error: "invalid_signature" });
          return;
        }
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const result = verifyWebhookDelivery({
          rawBody,
          signatureHeader: req.headers["x-hub-signature"],
          source,
          token,
        });
        if (!result.verified || result.sigKey === null) {
          res.status(401).json({ error: "invalid_signature" });
          return;
        }
        recordSignatureKeyUse(record.address, result.sigKey);
        res.status(202).json({ status: "queued", sigKey: result.sigKey });
      } catch {
        res.status(401).json({ error: "invalid_signature" });
      }
    },
  );
  return app;
}

async function post(app: express.Express, path: string, init: RequestInit) {
  const server = await new Promise<import("http").Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function delivery(token: string, secret: string) {
  const body = JSON.stringify({
    meeting_id: "01J8ZK",
    event: "meeting.transcribed",
  });
  return {
    path: `/api/connectors/webhooks/fireflies/${token}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": sign(Buffer.from(body), secret),
      },
      body,
    } satisfies RequestInit,
  };
}

describe("rotation eviction, end to end", () => {
  test("a delivery signed with the OLD token's secret is 401 immediately after rotation", async () => {
    const { service } = createService();
    const app = createApp(service);

    const first = await service.mint(ADDRESS, "fireflies");
    const firstSecret = deriveWebhookSecret("fireflies", first.token);

    const firstDelivery = delivery(first.token, firstSecret);
    const before = await post(app, firstDelivery.path, firstDelivery.init);
    expect(before.status).toBe(202);

    const second = await service.rotate(ADDRESS, "fireflies");

    const after = await post(app, firstDelivery.path, firstDelivery.init);
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "invalid_signature" });

    const secondDelivery = delivery(
      second.token,
      deriveWebhookSecret("fireflies", second.token),
    );
    const renewed = await post(app, secondDelivery.path, secondDelivery.init);
    expect(renewed.status).toBe(202);
  });

  test("a delivery under _PREV is accepted and reported as prev", async () => {
    const { service } = createService();
    const app = createApp(service);
    const { token } = await service.mint(ADDRESS, "fireflies");
    const oldSecret = deriveWebhookSecretWithMaster(
      "fireflies",
      token,
      MASTER_A,
    );

    process.env.WEBHOOK_HMAC_MASTER = MASTER_B;
    process.env.WEBHOOK_HMAC_MASTER_PREV = MASTER_A;

    const prevDelivery = delivery(token, oldSecret);
    const res = await post(app, prevDelivery.path, prevDelivery.init);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "queued", sigKey: "prev" });
    expect(webhookSigKeyCohort().prev).toBe(1);

    // Dropping _PREV is what actually revokes — and the cohort count is the signal for when.
    delete process.env.WEBHOOK_HMAC_MASTER_PREV;
    const dropped = await post(app, prevDelivery.path, prevDelivery.init);
    expect(dropped.status).toBe(401);
  });

  test("the ROTATED-AWAY url+secret is byte-identical to an unknown credential", async () => {
    // The UI claims a rotation succeeded only after the backend answered, and
    // what it tells the user is that the old address and secret "stop working
    // immediately". That promise is only kept if the old pair is
    // indistinguishable from a credential the server has never seen — a
    // different status, or a different body, would tell a holder of the old URL
    // that it was once real for this account.
    const { service } = createService();
    const app = createApp(service);

    const first = await service.mint(ADDRESS, "fireflies");
    const stale = delivery(first.token, deriveWebhookSecret("fireflies", first.token));
    await service.rotate(ADDRESS, "fireflies");

    const rotatedAway = await post(app, stale.path, stale.init);
    const neverSeen = delivery(
      generateWebhookToken(),
      deriveWebhookSecret("fireflies", generateWebhookToken()),
    );
    const unknown = await post(app, neverSeen.path, neverSeen.init);

    expect(rotatedAway.status).toBe(401);
    expect(rotatedAway.status).toBe(unknown.status);
    expect(await rotatedAway.text()).toBe(await unknown.text());
  });

  test("an unknown token and a bad signature are byte-identical rejections", async () => {
    const { service } = createService();
    const app = createApp(service);
    const { token } = await service.mint(ADDRESS, "fireflies");

    const unknownDelivery = delivery(generateWebhookToken(), "x".repeat(43));
    const badSigDelivery = delivery(token, "y".repeat(43));
    const unknown = await post(app, unknownDelivery.path, unknownDelivery.init);
    const badSig = await post(app, badSigDelivery.path, badSigDelivery.init);

    expect(unknown.status).toBe(badSig.status);
    expect(await unknown.text()).toBe(await badSig.text());
  });

  test("a non-ASCII x-hub-signature is answered 401, never 500", async () => {
    const { service } = createService();
    const app = createApp(service);
    const { token } = await service.mint(ADDRESS, "fireflies");

    const res = await post(app, `/api/connectors/webhooks/fireflies/${token}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature": "sha256=" + "Ã" + "a".repeat(63),
      },
      body: JSON.stringify({ meeting_id: "01J8ZK" }),
    });
    expect(res.status).toBe(401);
  });
});

// ── §9.3 read-side hardening: {ok:false} from kv.get must NOT be "absent" ──
//
// The write path already asserts a durable-Result failure through withSessionRefresh
// (mint/rotate/revoke tests above). The read helpers did NOT: they cast
// `(result as {data?}).data` and read a rejected Result as `null` / "no config", which is
// the exact silent open-fail class the assertion contract was written to close. Under a
// transient node-read rejection, `lookup(token)` would treat a KNOWN token as unknown and
// negative-cache the miss (§4.4), and `issue()` would treat an existing config as absent —
// re-minting the CONFIG key without ever `deleteKey`'ing the old token key, leaving the old
// token live and still verifying against its HKDF secret. Rejections propagate.

describe("read-side kv Result{ok:false} surfacing (§9.3)", () => {
  test("lookup REJECTS when kv.get on the token key returns ok:false — never negative-cached", async () => {
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    // Wipe the positive cache entry mint set so lookup goes to KV.
    service.evictAll();
    node.failGetFor = (key) => key === `webhooks/tokens/${token}`;

    await expect(service.lookup(token)).rejects.toThrow("KV operation failed");
    // A durable read failure is not a miss — it MUST NOT enter the (negative or positive)
    // cache (§4.4 anti-amplification). A next call gets a fresh chance, not a 60s DoS.
    expect(service.cacheStats()).toEqual({ positive: 0, negative: 0 });
  });

  test("config REJECTS when kv.get on the config key returns ok:false — no silent null", async () => {
    const { node, service } = createService();
    await service.mint(ADDRESS, "fireflies");
    node.failGetFor = (key) =>
      key === `webhooks/config/${ADDRESS.toLowerCase()}`;

    await expect(service.config(ADDRESS)).rejects.toThrow(
      "KV operation failed",
    );
  });

  test("issue REJECTS when the existing-config read returns ok:false — old token key stays live, no orphan write", async () => {
    // Without the read-side assertion, the existing-config read comes back as `null`,
    // `parseConfigRecord` returns null, the code enters the fresh-mint branch, and it writes
    // BOTH the new token key AND the new config key while the old token key survives — the
    // orphan-live-token scenario `revoke()`'s comment enumerates. The read rejection must
    // surface so no new keys are attempted.
    const { node, service } = createService();
    const first = await service.mint(ADDRESS, "fireflies");
    const storedKeysBefore = [...node.store.keys()];
    node.failGetFor = (key) =>
      key === `webhooks/config/${ADDRESS.toLowerCase()}`;

    await expect(service.rotate(ADDRESS, "fireflies")).rejects.toThrow(
      "KV operation failed",
    );

    // No new token key or config key was written on the failing branch.
    expect(new Set(node.store.keys())).toEqual(new Set(storedKeysBefore));
    // The old token key is still live and still resolvable — its config is intact.
    expect(node.store.has(`webhooks/tokens/${first.token}`)).toBe(true);
  });

  test("lookup with a session-class Result on the first kv.get takes the sign-in-and-retry path", async () => {
    // Same session-refresh contract as the write-side test above (mint session-Result retry).
    // A Result carrying "session expired" on the READ path must ride the single-refresh retry;
    // a non-session Result must not.
    const { node, service } = createService();
    const { token } = await service.mint(ADDRESS, "fireflies");
    service.evictAll();

    let signInCalls = 0;
    node.signIn = async () => {
      signInCalls += 1;
    };

    const originalGet = node.kv.get.bind(node.kv);
    let getCalls = 0;
    node.kv.get = async (key: string) => {
      if (key === `webhooks/tokens/${token}`) {
        getCalls += 1;
        if (getCalls === 1) return { ok: false, error: "session expired" };
      }
      return originalGet(key);
    };

    const record = await service.lookup(token);
    expect(record).not.toBeNull();
    expect(signInCalls).toBe(1);
    expect(getCalls).toBeGreaterThanOrEqual(2);
  });
});

// ── Redaction: KV keys carry raw meeting ids, redactedErrorMessage must strip them ──
//
// SDK errors on the caught-error paths that log via `redactedErrorMessage` sometimes embed the
// full failing KV key (e.g. `kv put failed for webhooks/pending/fireflies/0xabc.../MEETING-ID`).
// The existing token/address passes catch 43-char base64url and 40-hex-address, but Fireflies
// meeting ids (24–32 chars) pass both and ship raw onto the `public_logs=true` stream — the exact
// scenario §6.3 forbids. Add a targeted third pass for the code-controlled KV key shapes.

describe("redactedErrorMessage (§6.3 public log discipline)", () => {
  test("strips a meeting id embedded in a webhooks/pending KV key", () => {
    // The failing KV key shape carries source, address and meeting id. Address is caught by the
    // hex pass; the meeting id must be too — otherwise a Fireflies id ships raw to public logs.
    const meetingId = "01J8AAAAAAAAAAAAAAAAAAAA"; // 24-char ULID-ish
    const message = `kv put failed for webhooks/pending/fireflies/0xabc0000000000000000000000000000000000000/${meetingId}`;
    const redacted = redactedErrorMessage(new Error(message));
    expect(redacted).not.toContain(meetingId);
    expect(redacted).not.toContain(
      "0xabc0000000000000000000000000000000000000",
    );
    expect(redacted).toContain("<meeting>");
    expect(redacted).toContain("<address>");
  });

  test("strips a meeting id from webhooks/dead, corrupt, purged and corrupt/purged keys too", () => {
    const meetingId = "M1234567890abcdef1234";
    for (const bucket of ["dead", "corrupt", "purged", "corrupt/purged"]) {
      const message = `kv failed on webhooks/${bucket}/fireflies/0x0000000000000000000000000000000000000001/${meetingId}`;
      const redacted = redactedErrorMessage(new Error(message));
      expect(redacted).not.toContain(meetingId);
      expect(redacted).toContain("<meeting>");
    }
  });

  test("does not touch unrelated text", () => {
    // The rewrite is targeted at code-controlled KV key shapes only — routine SDK error text
    // (no key prefix) must not be blanket-alphanumeric-stripped or triage suffers.
    const message = "connection timeout waiting for node";
    expect(redactedErrorMessage(new Error(message))).toBe(message);
  });
});
