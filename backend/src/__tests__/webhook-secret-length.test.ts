import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetWebhookTokenState,
  deriveWebhookSecret,
  deriveLegacyWebhookSecretWithMaster,
  generateWebhookToken,
  verifyWebhookDelivery,
  webhookSecretFormCohort,
  WEBHOOK_SECRET_MAX_LENGTH,
  WEBHOOK_SECRET_MIN_LENGTH,
} from "../services/webhook-tokens.js";

/**
 * V-b — the webhook-secret LENGTH amendment (backend-ingest DECISIONS "Research provenance",
 * plan §10).
 *
 * Fireflies' dashboard webhook-secret field accepts **16–32 characters**. The shipped derivation
 * emitted `base64url(HKDF-SHA256(master, …, 32 bytes))` = **43 characters**, which cannot be
 * registered at all. This suite pins the amended length, the ONE scheme chosen for it, and the
 * compatibility arm for any hook that somehow registered under the legacy 43-char value.
 */

const MASTER = "3H8Qk0m2yq1sZ0VjK5xPwq0nA6oJ2bL9dR4tW7uY1cM=";
const ORIGINAL_ENV = { ...process.env };

function sign(body: Buffer, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

beforeEach(() => {
  _resetWebhookTokenState();
  process.env.WEBHOOK_HMAC_MASTER = MASTER;
  delete process.env.WEBHOOK_HMAC_MASTER_PREV;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
});

describe("V-b: derived delivery secret length", () => {
  test("fits Fireflies' 16-32 character secret field", () => {
    for (let i = 0; i < 25; i += 1) {
      const secret = deriveWebhookSecret("fireflies", generateWebhookToken());
      expect(secret.length).toBeGreaterThanOrEqual(WEBHOOK_SECRET_MIN_LENGTH);
      expect(secret.length).toBeLessThanOrEqual(WEBHOOK_SECRET_MAX_LENGTH);
      // Still a paste-safe alphabet — the field is copied by hand into a dashboard.
      expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("is ONE scheme: the base64url prefix of the legacy 43-char derivation", () => {
    const token = generateWebhookToken();
    const legacy = deriveLegacyWebhookSecretWithMaster("fireflies", token, MASTER);
    expect(legacy).toHaveLength(43);
    expect(deriveWebhookSecret("fireflies", token)).toBe(
      legacy.slice(0, WEBHOOK_SECRET_MAX_LENGTH),
    );
  });

  test("is still info-bound to BOTH the source and the token", () => {
    const token = generateWebhookToken();
    const other = generateWebhookToken();
    expect(deriveWebhookSecret("fireflies", token)).not.toBe(
      deriveWebhookSecret("granola", token),
    );
    expect(deriveWebhookSecret("fireflies", token)).not.toBe(
      deriveWebhookSecret("fireflies", other),
    );
  });
});

describe("V-b: verification across the amendment", () => {
  const body = Buffer.from(JSON.stringify({ meetingId: "abc", eventType: "x" }));

  test("the amended secret verifies as the current form", () => {
    const token = generateWebhookToken();
    const result = verifyWebhookDelivery({
      rawBody: body,
      signatureHeader: sign(body, deriveWebhookSecret("fireflies", token)),
      source: "fireflies",
      token,
    });
    expect(result.verified).toBe(true);
    expect(result.sigKey).toBe("current");
    expect(result.secretForm).toBe("current");
  });

  test("a hook already registered with the legacy 43-char secret still verifies, and the legacy use is surfaced", () => {
    const token = generateWebhookToken();
    const legacy = deriveLegacyWebhookSecretWithMaster("fireflies", token, MASTER);

    const result = verifyWebhookDelivery({
      rawBody: body,
      signatureHeader: sign(body, legacy),
      source: "fireflies",
      token,
    });

    // Never silently break an already-registered hook: it verifies, and it is COUNTED so the
    // re-registration can be driven to zero rather than hoped about.
    expect(result.verified).toBe(true);
    expect(result.secretForm).toBe("legacy");
    expect(webhookSecretFormCohort().legacy).toBe(1);
  });

  test("a wrong secret is still rejected under both forms", () => {
    const token = generateWebhookToken();
    const result = verifyWebhookDelivery({
      rawBody: body,
      signatureHeader: sign(body, "not-the-secret"),
      source: "fireflies",
      token,
    });
    expect(result.verified).toBe(false);
    expect(result.secretForm).toBeNull();
  });
});
