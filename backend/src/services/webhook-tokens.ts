import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import * as serverPackage from "@tinyboilerplate/server";
import { verifyFirefliesSignature } from "./webhook-verify.js";

const { assertKvResult, withSessionRefresh } = serverPackage;
const { isKvMissingKeyResult } = serverPackage as typeof serverPackage & {
  isKvMissingKeyResult: (result: unknown, key: string) => boolean;
};

/**
 * Per-user webhook routing tokens and the HMAC secrets derived from them (§4.1/§4.2/§4.4).
 *
 * Nothing per-user is stored as a secret at rest: the token->address map is not
 * secret-bearing, and the delivery secret is recomputed on demand as
 * `base64url(HKDF-SHA256(WEBHOOK_HMAC_MASTER, salt, info = "<source>:<token>"))`.
 * Rotating the token rotates the secret; rotating the master rotates every user's.
 *
 * ERROR CONVENTION: this service REJECTS rather than returning `Result` objects — the
 * deliberate deviation from `docs/connectors-spec.md` §4 documented at the head of
 * `connector-queue.ts` and in the spec itself.
 */

// ── Identifier validation ────────────────────────────────────────────
//
// ONE validator per identifier class, exported, used on BOTH the mint and the lookup path.
// A validator scoped to one route is how the second route ships without one (§4.5).
// Neither character class contains `%`, `/`, `\` or `.`, so `..`, `%2F` and every
// percent-decoded traversal form is rejected by construction — Express percent-decodes
// route params, so `/fireflies/..%2F..%2Fdelegations%2F0xabc` arrives as
// `../../delegations/0xabc` and fails here, before any KV key is built.

/** 32 random bytes, base64url — 43 chars, no padding (§4.1). */
export const WEBHOOK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Fireflies meeting ids are ULID-ish; the cap also bounds the queue value size (§4.5). */
export const MEETING_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Connector sources are registry ids (`fireflies`, `granola`, `google-meet`). */
export const WEBHOOK_SOURCE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidToken(token: unknown): token is string {
  return typeof token === "string" && WEBHOOK_TOKEN_PATTERN.test(token);
}

export function isValidMeetingId(meetingId: unknown): meetingId is string {
  return typeof meetingId === "string" && MEETING_ID_PATTERN.test(meetingId);
}

export function isValidSource(source: unknown): source is string {
  return typeof source === "string" && WEBHOOK_SOURCE_PATTERN.test(source);
}

/** Mint a routing token. Generated tokens go through `isValidToken` too — same gate, both paths. */
export function generateWebhookToken(): string {
  const token = randomBytes(32).toString("base64url");
  if (!isValidToken(token)) {
    throw new Error(
      "generateWebhookToken produced a token failing isValidToken",
    );
  }
  return token;
}

// ── Secret strength gate (§7.1/§4.2) ─────────────────────────────────

const HKDF_SALT = "tinychat-webhook-v1";
const MIN_SECRET_BYTES = 32;

/**
 * Values that are present but not secrets. Compared case-insensitively; the substring
 * entries catch the "long enough to pass the byte check, obviously a placeholder" class.
 */
const PLACEHOLDER_EXACT = new Set([
  "changeme",
  "change-me",
  "secret",
  "test",
  "password",
  "placeholder",
  "example",
  "dev",
  "local",
  "none",
  "off",
]);
const PLACEHOLDER_SUBSTRINGS = [
  "changeme",
  "change-me",
  "placeholder",
  "replace-me",
  "replaceme",
  "your-secret",
  "yoursecret",
  "insert-secret",
  "openssl",
];

/**
 * Decoded entropy in bytes, read conservatively: hex first, then base64/base64url, then
 * raw utf8. Taking the SMALLEST plausible reading is deliberate — this is a floor check,
 * and the two documented generation paths (`openssl rand -base64 32` => 44 chars => 32
 * bytes; 64 hex chars => 32 bytes) both clear it.
 */
function decodedByteLength(value: string): number {
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return value.length / 2;
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(normalized, "base64").length;
  }
  return Buffer.byteLength(value, "utf8");
}

export interface AssertStrongSecretOptions {
  /** When true, an absent value is accepted (returns null). A PRESENT value is still gated. */
  optional?: boolean;
  /** Suppress the accepted-length log line (tests). */
  quiet?: boolean;
}

/**
 * Refuse to boot on a WEAK secret, not merely a missing one (§7.1).
 *
 * §4.2's derivation hands every consenting user a complete (public salt, known info,
 * displayed 32-byte output) oracle against `WEBHOOK_HMAC_MASTER`, testable offline at any
 * rate — so a weak master is a silent, total compromise of delivery authentication for the
 * whole cohort, not a per-user problem.
 *
 * Throws on rejection so it is unit-testable; the boot path catches and `process.exit(1)`s.
 * Returns the accepted decoded byte length, and logs the LENGTH — never the value.
 */
export function assertStrongSecret(
  name: string,
  value: string | undefined,
  options: AssertStrongSecretOptions = {},
): number | null {
  const trimmed = typeof value === "string" ? value.trim() : "";

  if (trimmed.length === 0) {
    if (options.optional) return null;
    throw new Error(
      `[startup] FATAL: ${name} is missing or too weak (need >=32 decoded bytes)`,
    );
  }

  const lowered = trimmed.toLowerCase();
  const isPlaceholder =
    PLACEHOLDER_EXACT.has(lowered) ||
    PLACEHOLDER_SUBSTRINGS.some((needle) => lowered.includes(needle)) ||
    /^(.)\1*$/.test(trimmed);

  if (isPlaceholder) {
    throw new Error(
      `[startup] FATAL: ${name} is missing or too weak (need >=32 decoded bytes)`,
    );
  }

  const bytes = decodedByteLength(trimmed);
  if (bytes < MIN_SECRET_BYTES) {
    throw new Error(
      `[startup] FATAL: ${name} is missing or too weak (need >=32 decoded bytes)`,
    );
  }

  if (!options.quiet) {
    console.log(`[startup] ${name} accepted (${bytes} decoded bytes)`);
  }
  return bytes;
}

// ── Master keys + HKDF derivation (§4.2) ─────────────────────────────

const validatedMasters = new Set<string>();

function requireStrongMaster(name: string, value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const memoKey = `${name}\u0000${trimmed}`;
  if (!validatedMasters.has(memoKey)) {
    assertStrongSecret(name, trimmed, { quiet: true });
    validatedMasters.add(memoKey);
  }
  return trimmed;
}

/** The current master. Throws if unset or weak — never a fallback that hides it. */
export function currentWebhookMaster(): string {
  return requireStrongMaster(
    "WEBHOOK_HMAC_MASTER",
    process.env.WEBHOOK_HMAC_MASTER,
  );
}

/**
 * The rotation grace key, or null when no rotation is in flight (§4.2/§7.6).
 * A present-but-weak `_PREV` throws: the grace window must not be the weak-key window.
 */
export function previousWebhookMaster(): string | null {
  const raw = process.env.WEBHOOK_HMAC_MASTER_PREV;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return requireStrongMaster("WEBHOOK_HMAC_MASTER_PREV", raw);
}

// ── V-b: the secret-LENGTH amendment ─────────────────────────────────
//
// Fireflies' dashboard webhook-secret field accepts **16-32 characters** (backend-ingest
// DECISIONS "Research provenance" -> V-b). The shipped derivation emitted the base64url of a
// 32-byte HKDF output = **43 characters**, which cannot be registered at all — so this is a
// correctness fix for the SHIPPED Option-C registration as much as a pre-req for anything the
// backend-ingest build registers.
//
// THE CHOSEN SCHEME, stated once and used everywhere: take **24 bytes** of the same HKDF stream
// and base64url them. 24 is divisible by 3, so the encoding is exactly 32 characters with no
// padding — the top of the permitted range — and, because HKDF-Expand's output for L=24 is the
// 24-byte prefix of its output for L=32, the amended secret is *byte for byte* the 32-character
// prefix of the legacy 43-character value. One scheme, two readings: "truncate the base64url to
// 32 chars" and "derive 24 bytes" are the same string, so a future reader cannot pick the wrong
// one. 192 bits of HMAC key material is far above any brute-force concern here.
//
// The legacy form is retained for VERIFICATION ONLY (`deriveLegacyWebhookSecretWithMaster`):
// V-b is docs-grounded rather than live-tested, so if any hook did register with the 43-char
// value its deliveries must keep verifying — and they are counted, not silently accepted, so the
// re-registration can be driven to zero. Nothing MINTS the legacy form any more.

/** The provider field's bounds. Asserted in `webhook-secret-length.test.ts`. */
export const WEBHOOK_SECRET_MIN_LENGTH = 16;
export const WEBHOOK_SECRET_MAX_LENGTH = 32;
/** 24 bytes -> exactly 32 base64url chars, no padding, no truncation ambiguity. */
export const WEBHOOK_SECRET_BYTES = 24;
/** The pre-amendment 32-byte / 43-char form. Verification-only. */
export const LEGACY_WEBHOOK_SECRET_BYTES = 32;

function deriveSecretBytes(
  source: string,
  token: string,
  master: string,
  bytes: number,
): string {
  if (!isValidSource(source))
    throw new Error("deriveWebhookSecret: invalid source");
  if (!isValidToken(token))
    throw new Error("deriveWebhookSecret: invalid token");
  if (typeof master !== "string" || master.length === 0) {
    throw new Error("deriveWebhookSecret: empty master");
  }
  const derived = hkdfSync(
    "sha256",
    master,
    HKDF_SALT,
    `${source}:${token}`,
    bytes,
  );
  return Buffer.from(derived).toString("base64url");
}

/**
 * `base64url(HKDF-SHA256(ikm = master, salt = "tinychat-webhook-v1",
 *                        info = "<source>:<token>", length = 24))` — 32 chars (see above).
 *
 * `info` binds the secret to BOTH the source and the token, so a secret is useless against
 * a different token and a different connector.
 */
export function deriveWebhookSecretWithMaster(
  source: string,
  token: string,
  master: string,
): string {
  return deriveSecretBytes(source, token, master, WEBHOOK_SECRET_BYTES);
}

/**
 * The pre-amendment 43-char form. Used ONLY by `verifyWebhookDelivery`'s compatibility arm so a
 * hook registered before the amendment does not silently stop verifying. Never displayed.
 */
export function deriveLegacyWebhookSecretWithMaster(
  source: string,
  token: string,
  master: string,
): string {
  return deriveSecretBytes(source, token, master, LEGACY_WEBHOOK_SECRET_BYTES);
}

/** The secret shown to the user for pasting into their provider dashboard (§3.1 step 5). */
export function deriveWebhookSecret(source: string, token: string): string {
  return deriveWebhookSecretWithMaster(source, token, currentWebhookMaster());
}

// ── Delivery verification across a master rotation ───────────────────

export type WebhookSigKey = "current" | "prev";

/** Which DERIVATION emitted the secret a delivery signed with — see the V-b note above. */
export type WebhookSecretForm = "current" | "legacy";

export interface WebhookVerifyResult {
  verified: boolean;
  /**
   * Which master matched. The handler carries this onto its per-delivery `recv` line as
   * `sig_key=current|prev` (§6.3) and feeds it to `recordSignatureKeyUse` so §7.6's
   * "watch the migration drain to zero" is an actual number rather than a hope.
   */
  sigKey: WebhookSigKey | null;
  /**
   * `legacy` = the delivery was signed with the pre-V-b 43-char secret, i.e. the hook is still
   * registered with a value the provider's own field length says it should not have accepted.
   * Counted in `webhookSecretFormCohort()` so re-registration is a number, not a hope.
   */
  secretForm: WebhookSecretForm | null;
}

const REJECTED: WebhookVerifyResult = {
  verified: false,
  sigKey: null,
  secretForm: null,
};

/**
 * Verify a delivery against the current master, then — only if that fails — against
 * `WEBHOOK_HMAC_MASTER_PREV` (§4.2's bounded grace window). Each master is tried with the
 * amended 32-char secret first and the legacy 43-char secret second (V-b compatibility arm):
 * both forms come out of the same HKDF stream under the same master, so the legacy arm adds no
 * key material and no new trust — it only keeps an already-registered hook from breaking
 * silently.
 */
export function verifyWebhookDelivery(input: {
  rawBody: Buffer;
  signatureHeader: string | string[] | undefined;
  source: string;
  token: string;
}): WebhookVerifyResult {
  const { rawBody, signatureHeader, source, token } = input;
  if (!isValidSource(source) || !isValidToken(token)) return REJECTED;

  const attempt = (
    master: string,
    sigKey: WebhookSigKey,
  ): WebhookVerifyResult | null => {
    if (
      verifyFirefliesSignature(
        rawBody,
        signatureHeader,
        deriveWebhookSecretWithMaster(source, token, master),
      )
    ) {
      recordSecretFormUse(token, "current");
      return { verified: true, sigKey, secretForm: "current" };
    }
    if (
      verifyFirefliesSignature(
        rawBody,
        signatureHeader,
        deriveLegacyWebhookSecretWithMaster(source, token, master),
      )
    ) {
      recordSecretFormUse(token, "legacy");
      return { verified: true, sigKey, secretForm: "legacy" };
    }
    return null;
  };

  const current = attempt(currentWebhookMaster(), "current");
  if (current !== null) return current;

  const previous = previousWebhookMaster();
  if (previous === null) return REJECTED;

  return attempt(previous, "prev") ?? REJECTED;
}

// ── V-b re-registration cohort (the "drain to zero" number) ──────────

const secretFormCohort = new Map<string, WebhookSecretForm>();

/**
 * Keyed by TOKEN, not address: verification runs before the token->address lookup, and a token
 * is exactly as specific. Logs only on a TRANSITION (a steady cohort must not spam the public
 * stream) and never logs the token raw — the same discipline as `recordSignatureKeyUse`.
 */
function recordSecretFormUse(token: string, form: WebhookSecretForm): void {
  const previous = secretFormCohort.get(token);
  if (previous === form) return;

  if (secretFormCohort.size >= MAX_COHORT_ENTRIES && previous === undefined) {
    const oldest = secretFormCohort.keys().next();
    if (!oldest.done) secretFormCohort.delete(oldest.value);
  }
  secretFormCohort.set(token, form);

  if (form === "legacy") {
    // A hook registered with the pre-amendment 43-char secret. It still verifies — but the
    // operator has to know it exists, because it is the one thing V-b's docs say cannot happen.
    console.warn(
      `[connector-webhook] op=secret-form form=legacy tid=${hashedAddress(token)} ` +
        `legacy_cohort=${countSecretForm("legacy")} t=${new Date().toISOString()}`,
    );
  }
}

function countSecretForm(form: WebhookSecretForm): number {
  let count = 0;
  for (const value of secretFormCohort.values()) if (value === form) count += 1;
  return count;
}

/** How many tokens are still signing with the pre-amendment secret. Target: zero. */
export function webhookSecretFormCohort(): {
  current: number;
  legacy: number;
  total: number;
} {
  return {
    current: countSecretForm("current"),
    legacy: countSecretForm("legacy"),
    total: secretFormCohort.size,
  };
}

// ── Rotation cohort counter (§7.6 — "drain to zero" must be a number) ─

const MAX_COHORT_ENTRIES = 10_000;
const sigKeyCohort = new Map<string, WebhookSigKey>();

/**
 * Keyed log hash for §6.3's `aid=`/`mid=`/`tid=` fields: HMAC-SHA256 under `LOG_HASH_SALT`,
 * truncated to 16 hex chars (>=64 bits — 8 hex collides at ~65k ids).
 *
 * `LOG_HASH_SALT` is its own env var and is explicitly NOT derived from
 * `WEBHOOK_HMAC_MASTER`: reuse would make every historical public log line an oracle for
 * anyone who later obtains the master.
 */
export function keyedLogHash(value: string, bytes = 8): string {
  const salt = process.env.LOG_HASH_SALT;
  if (typeof salt !== "string" || salt.trim().length === 0) {
    throw new Error("LOG_HASH_SALT is not configured");
  }
  return createHmac("sha256", salt.trim())
    .update(value)
    .digest("hex")
    .slice(0, bytes * 2);
}

/**
 * The guarded form every peer call site uses (`hashed()` in the queue and the drain,
 * `hashedField()` in the route): a missing `LOG_HASH_SALT` drops the field rather than throwing
 * out of the logger. `revoke()`'s unparseable-config branch called `keyedLogHash` bare, so with
 * the salt absent that branch failed with a TypeError from its own log line — before
 * `deleteKey(configKey(addr))` on the next line — turning "refuse to report a clean revoke" into
 * "leave the config key in place". A branch should fail with its own error for its own reason.
 */
function hashedAddress(value: string): string {
  try {
    return keyedLogHash(value);
  } catch {
    return "unavailable";
  }
}

/**
 * Record which master an address is verifying under. Logs only on a TRANSITION, so a steady
 * cohort does not spam the public stream, and never logs a raw address.
 */
export function recordSignatureKeyUse(
  address: string,
  sigKey: WebhookSigKey,
): void {
  const key = address.toLowerCase();
  const previous = sigKeyCohort.get(key);
  if (previous === sigKey) return;

  if (sigKeyCohort.size >= MAX_COHORT_ENTRIES && previous === undefined) {
    const oldest = sigKeyCohort.keys().next();
    if (!oldest.done) {
      sigKeyCohort.delete(oldest.value);
      // No silent caps: an evicted entry means the cohort count is now a floor, not a total.
      console.warn(
        `[connector-webhook] op=cohort-evict reason=cap cap=${MAX_COHORT_ENTRIES} t=${new Date().toISOString()}`,
      );
    }
  }

  sigKeyCohort.set(key, sigKey);
  // LOG_HASH_SALT unset (flag-off / test contexts): drop the field rather than fake it.
  const aid = hashedAddress(key);
  console.log(
    `[connector-webhook] op=sig-key sig_key=${sigKey} aid=${aid} ` +
      `prev_cohort=${countSigKey("prev")} t=${new Date().toISOString()}`,
  );
}

function countSigKey(sigKey: WebhookSigKey): number {
  let count = 0;
  for (const value of sigKeyCohort.values()) if (value === sigKey) count += 1;
  return count;
}

/**
 * The number §7.6 step 2 and step 4 need: how many addresses are still verifying under
 * `_PREV`. `_PREV` is not dropped while `prev` is non-zero without a recorded decision.
 */
export function webhookSigKeyCohort(): {
  current: number;
  prev: number;
  total: number;
} {
  const prev = countSigKey("prev");
  const current = countSigKey("current");
  return { current, prev, total: sigKeyCohort.size };
}

const ADDRESS_LIKE = /0x[a-fA-F0-9]{40}/g;
const TOKEN_LIKE = /[A-Za-z0-9_-]{43}/g;
/**
 * Code-controlled KV key shape carrying a raw meeting id in the tail segment. Fireflies ids
 * are typically 24–32 chars — they pass under TOKEN_LIKE's 43-char pattern and would otherwise
 * ship raw onto the `public_logs=true` stream (§6.3). The rewrite targets ONLY these known
 * key prefixes so unrelated triage text is preserved verbatim; the `<address>` pass has
 * already run and reduced the address segment to `<address>` before this fires. Order matters
 * here — this pattern MUST run after ADDRESS_LIKE.
 */
const WEBHOOK_KEY_MEETING_LIKE =
  /(webhooks\/(?:pending|dead|corrupt|purged|corrupt\/purged)\/[a-z0-9-]+\/<address>\/)([A-Za-z0-9_-]+)/g;
/**
 * W8 (plan §8.1 W8; §9 anti-pattern 7). The three passes above are a DENYLIST of shapes we
 * already knew about — a 40-hex address, a 43-char token, our own KV key layout. Backend ingest
 * put two new classes of string into the reach of an error message: a provider credential
 * (`ff-access-token-…`, a refresh token, an API key) and a meeting id in any position that is not
 * one of our KV keys. Neither matches a pass above, and both would ship raw onto the
 * `public_logs=true` stream from any `err=${redactedErrorMessage(error)}` field.
 *
 * So the last pass is a DEFAULT-DENY on shape rather than on provenance: an unbroken run of 20+
 * identifier characters is an opaque id or a secret, never prose. It runs LAST so the specific
 * placeholders above (`<address>`, `<meeting>`, `<token>`) are already in place and survive, and
 * the length floor is above every word a human error message contains — the "does not touch
 * unrelated text" case is exactly what it must not break.
 */
const OPAQUE_LIKE = /[A-Za-z0-9_-]{20,}/g;
const MAX_LOGGED_ERROR_LENGTH = 300;

/**
 * §6.3 operating assumption — `public_logs=true` on the CVM, so: ids only, never payload
 * content, never key material. The connector code hashes every id it logs itself, and then
 * `console.warn("…failed:", error)` walks around all of it: the KV keys these calls are built
 * from embed the raw token and the raw address, an Error prints its own enumerable properties
 * (body-parser puts the request body on one), and nothing promises the SDK keeps the key out of
 * its message. So: message only, never the object, with the two id shapes redacted and a length
 * bound.
 */
export function redactedErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "unknown";
  return message
    .replace(ADDRESS_LIKE, "<address>")
    .replace(WEBHOOK_KEY_MEETING_LIKE, "$1<meeting>")
    .replace(TOKEN_LIKE, "<token>")
    .replace(OPAQUE_LIKE, "<redacted>")
    .slice(0, MAX_LOGGED_ERROR_LENGTH);
}

// ── Token store (backend-own KV, §4.1) ───────────────────────────────

export interface WebhookTokenRecord {
  address: string;
  source: string;
  createdAt: string;
  rotatedFrom?: string;
}

export interface WebhookConfigRecord {
  token: string;
  source: string;
  createdAt: string;
}

export interface WebhookTokenServiceOptions {
  /** Positive cache TTL. Rotation evicts explicitly, so this never outlives a rotation. */
  positiveTtlMs?: number;
  /** Negative cache TTL — the anti-amplification half (§4.4). */
  negativeTtlMs?: number;
  maxCacheEntries?: number;
}

const DEFAULT_POSITIVE_TTL_MS = 5 * 60_000;
const DEFAULT_NEGATIVE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 10_000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * The single address validator for every backend-KV key segment built from an address
 * (`webhooks/config/{address}`, and §5.1's queue keys). Same discipline as `isValidToken`:
 * ONE validator, used by every path that turns an address into a key, so `/`, `\` and `..`
 * are rejected by construction rather than per call site.
 */
export function normalizeWebhookAddress(address: unknown): string {
  if (typeof address !== "string" || !ADDRESS_PATTERN.test(address)) {
    throw new Error("Invalid webhook config address");
  }
  return address.toLowerCase();
}

const normalizeAddress = normalizeWebhookAddress;

function normalizeSource(source: unknown): string {
  if (!isValidSource(source)) throw new Error("Invalid webhook source");
  return source;
}

function tokenKey(token: string): string {
  if (!isValidToken(token)) throw new Error("Invalid webhook token");
  return `webhooks/tokens/${token}`;
}

function configKey(address: string): string {
  return `webhooks/config/${normalizeAddress(address)}`;
}

function parseTokenRecord(raw: unknown): WebhookTokenRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (
    typeof value.address !== "string" ||
    !ADDRESS_PATTERN.test(value.address) ||
    !isValidSource(value.source) ||
    typeof value.createdAt !== "string"
  ) {
    return null;
  }
  const record: WebhookTokenRecord = {
    address: value.address.toLowerCase(),
    source: value.source,
    createdAt: value.createdAt,
  };
  if (isValidToken(value.rotatedFrom)) record.rotatedFrom = value.rotatedFrom;
  return record;
}

/**
 * The `token` field of a config value whose OTHER fields did not validate. A revoke keyed off
 * `parseConfigRecord` alone orphans a live token whenever `source` (or anything else) is
 * corrupt; the token itself is self-validating, so it is recoverable on its own.
 */
function rawConfigToken(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = (raw as Record<string, unknown>).token;
  return isValidToken(value) ? value : null;
}

function parseConfigRecord(raw: unknown): WebhookConfigRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (!isValidToken(value.token) || !isValidSource(value.source)) return null;
  return {
    token: value.token,
    source: value.source,
    createdAt:
      typeof value.createdAt === "string"
        ? value.createdAt
        : new Date(0).toISOString(),
  };
}

interface CacheEntry {
  record: WebhookTokenRecord | null;
  expiresAt: number;
}

/**
 * Mint / rotate / look up per-user webhook tokens in the backend's own KV, with the
 * MANDATORY in-process token->address cache in front of it (§4.4): the lookup sits ahead of
 * HMAC on an unauthenticated route, so an uncached miss is an amplified round trip against
 * the shared single-writer node and a live-token timing oracle.
 *
 * All node calls run through one per-instance lane — TinyCloud drops concurrent responses
 * on a single space (§9.3), so a rotate must never interleave with another rotate.
 */
export class WebhookTokenService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly maxCacheEntries: number;
  private lane: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly node: TinyCloudNode,
    options: WebhookTokenServiceOptions = {},
  ) {
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  /** Issue the first token for an address. */
  mint(
    address: string,
    source: string,
  ): Promise<{
    token: string;
    record: WebhookTokenRecord;
    rotatedFrom: string | null;
  }> {
    return this.issue(address, source);
  }

  /**
   * Rotate: a new token is written, the old token key is deleted, and the old token is
   * evicted from the cache before this resolves. Deleting the KV key alone does NOT revoke
   * — until the entry ages out the old token would still resolve and its HKDF secret would
   * still verify (§4.4). "Revoked" must mean revoked.
   */
  rotate(
    address: string,
    source: string,
  ): Promise<{
    token: string;
    record: WebhookTokenRecord;
    rotatedFrom: string | null;
  }> {
    return this.issue(address, source);
  }

  /**
   * Resolve a token to its owner. Returns null for a malformed token WITHOUT touching KV —
   * the traversal guard and the amplification guard are the same guard (§4.1).
   */
  async lookup(token: unknown): Promise<WebhookTokenRecord | null> {
    if (!isValidToken(token)) return null;

    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      // Refresh LRU position.
      this.cache.delete(token);
      this.cache.set(token, cached);
      return cached.record;
    }
    if (cached) this.cache.delete(token);

    // A KV failure propagates: an error is not a miss, and must never be negative-cached.
    const raw = await this.run(() => this.readJson(tokenKey(token)));
    const record = parseTokenRecord(raw);
    if (raw !== null && record === null) {
      console.warn(
        `[connector-webhook] op=token-record reason=unparseable t=${new Date().toISOString()}`,
      );
    }
    this.cacheSet(token, record);
    return record;
  }

  /** The reverse index the setup UI reads so it never has to scan (§4.1). */
  async config(address: string): Promise<WebhookConfigRecord | null> {
    const key = configKey(address);
    return parseConfigRecord(await this.run(() => this.readJson(key)));
  }

  /**
   * Idempotent teardown: token key, config key, cache entry.
   *
   * Fails LOUDLY on a config value it cannot read. Deleting only the config key would leave the
   * token key alive and still resolving to the address — the public route checks token→address
   * and never the disabled marker, so it would keep answering 202 and consuming the shared
   * node's write budget for a user who has revoked, while the teardown answered `200 disabled`.
   * Re-enabling then takes the mint branch (no existing config), so nothing ever cleans it up.
   * The token is therefore recovered from the raw value when the rest of the record is invalid.
   *
   * When even THAT fails, the previous behaviour was to leave both keys in place and throw — and
   * that turned the branch meant to prevent an orphaned live token into the one that guarantees
   * it. The route has already written the durable disabled marker by then, so it answers 503
   * `teardown_incomplete`; the client retries the same idempotent call and it throws again,
   * permanently, while the public handler (which resolves token→address and never reads the
   * marker) keeps verifying deliveries and returning 202 for a revoked account. So the in-process
   * cache is swept for every token that resolves to this address and each one is deleted
   * best-effort FIRST. Only then do we still fail loudly — the config key may name a token the
   * cache never saw, and a silent "clean revoke" would hide that from the operator.
   */
  async revoke(address: string): Promise<void> {
    const addr = normalizeAddress(address);
    await this.run(async () => {
      const raw = await this.readJson(configKey(addr));
      const existing = parseConfigRecord(raw);
      const token = existing?.token ?? rawConfigToken(raw);
      if (token !== null) {
        await this.deleteKey(tokenKey(token));
        this.evict(token);
      } else if (raw !== null) {
        const orphans = [...this.cache.entries()]
          .filter(
            ([, entry]) =>
              entry.record !== null && entry.record.address === addr,
          )
          .map(([cached]) => cached);
        for (const orphan of orphans) {
          try {
            await this.deleteKey(tokenKey(orphan));
          } catch (error) {
            console.warn(
              "[connector-webhook] orphan token delete failed:",
              redactedErrorMessage(error),
            );
          }
          this.evict(orphan);
        }
        console.warn(
          `[connector-webhook] op=revoke reason=unparseable_config aid=${hashedAddress(addr)} ` +
            `orphan_tokens_deleted=${orphans.length}`,
        );
        throw new Error(
          "Webhook config record is unparseable; refusing to report a clean revoke",
        );
      }
      await this.deleteKey(configKey(addr));
    });
  }

  /** Drop a token from the in-process cache immediately. */
  evict(token: string): void {
    this.cache.delete(token);
  }

  evictAll(): void {
    this.cache.clear();
  }

  cacheStats(): { positive: number; negative: number } {
    let positive = 0;
    let negative = 0;
    for (const entry of this.cache.values()) {
      if (entry.record === null) negative += 1;
      else positive += 1;
    }
    return { positive, negative };
  }

  private async issue(
    address: string,
    source: string,
  ): Promise<{
    token: string;
    record: WebhookTokenRecord;
    rotatedFrom: string | null;
  }> {
    const addr = normalizeAddress(address);
    const src = normalizeSource(source);
    const token = generateWebhookToken();

    return this.run(async () => {
      const existing = parseConfigRecord(await this.readJson(configKey(addr)));
      const createdAt = new Date().toISOString();
      const record: WebhookTokenRecord = {
        address: addr,
        source: src,
        createdAt,
      };
      if (existing) record.rotatedFrom = existing.token;

      // Persist the candidate before revoking the old token, but do not publish it through the
      // config or cache until every required write acknowledges. If old-token deletion fails,
      // the config still names the usable old credential and a retry can start over safely. If
      // the config write fails after deletion, the old config points at a revoked token (closed)
      // and the retry accepts the old key's exact missing-key result idempotently.
      await this.writeJson(tokenKey(token), record);

      if (existing && existing.token !== token) {
        await this.deleteKey(tokenKey(existing.token));
        this.evict(existing.token);
      }

      await this.writeJson(configKey(addr), { token, source: src, createdAt });
      this.cacheSet(token, record);
      return { token, record, rotatedFrom: existing?.token ?? null };
    });
  }

  private cacheSet(token: string, record: WebhookTokenRecord | null): void {
    if (this.cache.size >= this.maxCacheEntries && !this.cache.has(token)) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.delete(token);
    this.cache.set(token, {
      record,
      expiresAt:
        Date.now() +
        (record === null ? this.negativeTtlMs : this.positiveTtlMs),
    });
  }

  private async readJson(key: string): Promise<unknown> {
    // §9.3 read-side hardening: the SDK's KV surface resolves `{ok:false,error}` on a durable
    // failure — the promise no longer rejects. Casting `(result as {data?}).data` would read that
    // as `undefined` and let a rejected read return `null`, which `lookup`/`config`/`issue` above
    // then treat as "no such token" / "no existing config" — negative-caching a live token or
    // orphaning it during rotate. Assert INSIDE `withSessionRefresh` (mirrors delegation-store.ts:
    // 61-64) so a session-class Result surfaces as a session-matching Error and the single-refresh
    // retry still applies on reads.
    const result = await withSessionRefresh(this.node, async () => {
      const r = await this.node.kv.get(key);
      if (isKvMissingKeyResult(r, key)) return null;
      return assertKvResult(r);
    });
    const response = (result as { data?: unknown } | null)?.data as
      | { data?: unknown }
      | null
      | undefined;
    if (!response) return null;
    let raw: unknown = response.data ?? response;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        console.warn(
          `[connector-webhook] op=kv-read reason=unparseable t=${new Date().toISOString()}`,
        );
        return null;
      }
    }
    return raw;
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    // §9.3 durable-Result contract: the SDK reports a durable KV failure as `{ok:false,error}`
    // and no longer rejects. The assertion must run INSIDE withSessionRefresh so a
    // session-class Result surfaces as a session-matching Error and the single-refresh retry
    // still applies — same shape as delegation-store.ts / connector-queue.ts.
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.put(key, value);
      assertKvResult(result);
    });
  }

  private async deleteKey(key: string): Promise<void> {
    await withSessionRefresh(this.node, async () => {
      const result = await this.node.kv.delete(key);
      if (isKvMissingKeyResult(result, key)) return;
      assertKvResult(result);
    });
  }

  /** One lane per instance: storage calls are sequential, never concurrent (§9.3). */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(fn, fn);
    this.lane = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** Test hook (house convention, cf. `billing/stripe.ts`'s `_resetCache`). */
export function _resetWebhookTokenState(): void {
  validatedMasters.clear();
  sigKeyCohort.clear();
  secretFormCohort.clear();
}
