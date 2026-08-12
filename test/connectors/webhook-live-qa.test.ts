import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  assertBurstDeliveriesAcceptedExactlyOnce,
  assertDuplicateDeliveryIdempotent,
  assertInvalidSignatureRejection,
  assertLoopbackUrl,
  assertMissingCompanionCsrfRejected,
  assertOptionCHappyPath,
  assertStaleDeliveryRejected,
  assertUnsupportedEventIgnored,
  configureWebhookBeforeDelegation,
  invalidWebhookSignature,
  withoutProtocolBookkeepingPermissions,
  webhookSignature,
  type ConnectorStorageCounts,
  type PendingPayload,
} from "./webhook-live-qa.ts";

describe("webhook live QA safeguards", () => {
  test("removes only the generated capabilities-read bookkeeping permission", () => {
    const threads = {
      service: "tinycloud.kv",
      space: "did:key:space",
      path: "xyz.tinycloud.tinychat/threads/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    };
    const generated = {
      service: "tinycloud.capabilities",
      space: "did:key:space",
      path: "",
      actions: ["tinycloud.capabilities/read"],
    };
    const nonGenerated = {
      ...generated,
      actions: ["tinycloud.capabilities/read", "tinycloud.capabilities/write"],
    };

    expect(
      withoutProtocolBookkeepingPermissions([threads, generated, nonGenerated]),
    ).toEqual([threads, nonGenerated]);
  });

  test("accepts only HTTP(S) loopback URLs", () => {
    expect(
      assertLoopbackUrl("https://localhost:3014", "backend").hostname,
    ).toBe("localhost");
    expect(
      assertLoopbackUrl("http://127.0.0.1:4801/hook", "delivery").hostname,
    ).toBe("127.0.0.1");
    expect(assertLoopbackUrl("https://[::1]:3014", "backend").hostname).toBe(
      "[::1]",
    );

    expect(() =>
      assertLoopbackUrl("https://node.tinycloud.xyz", "backend"),
    ).toThrow(/loopback/);
    expect(() => assertLoopbackUrl("file:///tmp/hook", "delivery")).toThrow(
      /HTTP/,
    );
  });

  test("signs the exact UTF-8 body with the revealed delivery secret", () => {
    const body = JSON.stringify({
      meeting_id: "qa-meeting",
      event: "meeting.transcribed",
    });
    const secret = "revealed-local-qa-secret";
    const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

    expect(webhookSignature(body, secret)).toBe(expected);
  });

  test("builds a well-formed but incorrect provider signature", () => {
    const body = JSON.stringify({
      meeting_id: "qa-invalid-signature",
      event: "meeting.transcribed",
    });
    const secret = "revealed-local-qa-secret";

    const signature = invalidWebhookSignature(body, secret);

    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signature).not.toBe(webhookSignature(body, secret));
  });

  test("requires known and unknown tokens to return the same invalid-signature response", () => {
    const meetingId = "qa-invalid-signature";
    const before: PendingPayload = { count: 0, pending: [] };
    const rejected = {
      status: 401,
      text: JSON.stringify({ error: "invalid_signature" }),
      contentType: "application/json; charset=utf-8",
      contentLength: "29",
    };
    const input = {
      meetingId,
      knownToken: rejected,
      unknownToken: rejected,
      pending: before,
    };

    expect(() => assertInvalidSignatureRejection(input)).not.toThrow();
    expect(() =>
      assertInvalidSignatureRejection({
        ...input,
        knownToken: { ...rejected, status: 202 },
      }),
    ).toThrow(/401/);
    expect(() =>
      assertInvalidSignatureRejection({
        ...input,
        unknownToken: { ...rejected, text: '{"error":"different"}' },
      }),
    ).toThrow(/raw response/);
    expect(() =>
      assertInvalidSignatureRejection({
        ...input,
        unknownToken: { ...rejected, contentLength: null },
      }),
    ).toThrow(/metadata/);
    expect(() =>
      assertInvalidSignatureRejection({
        ...input,
        pending: { count: 1, pending: [{ meetingId }] },
      }),
    ).toThrow(/queue changed/);
  });

  test("accepts only an ignored unsupported event that leaves the queue empty", () => {
    const meetingId = "qa-unsupported-event";
    const input = {
      meetingId,
      deliveryStatus: 200,
      deliveryBody: { status: "ignored", event: "meeting.created" },
      pending: { count: 0, pending: [] } satisfies PendingPayload,
    };

    expect(() => assertUnsupportedEventIgnored(input)).not.toThrow();
    expect(() =>
      assertUnsupportedEventIgnored({ ...input, deliveryStatus: 202 }),
    ).toThrow(/200/);
    expect(() =>
      assertUnsupportedEventIgnored({
        ...input,
        deliveryBody: {
          status: "ignored",
          event: "meeting.created",
          extra: true,
        },
      }),
    ).toThrow(/body/);
    expect(() =>
      assertUnsupportedEventIgnored({
        ...input,
        pending: { count: 1, pending: [{ meetingId }] },
      }),
    ).toThrow(/queue changed/);
  });

  test("accepts only a stale-delivery rejection that leaves the queue empty", () => {
    const meetingId = "qa-stale-delivery";
    const input = {
      meetingId,
      deliveryStatus: 400,
      deliveryBody: { error: "stale_delivery" },
      pending: { count: 0, pending: [] } satisfies PendingPayload,
    };

    expect(() => assertStaleDeliveryRejected(input)).not.toThrow();
    expect(() =>
      assertStaleDeliveryRejected({ ...input, deliveryStatus: 202 }),
    ).toThrow(/400/);
    expect(() =>
      assertStaleDeliveryRejected({
        ...input,
        deliveryBody: { error: "stale_delivery", extra: true },
      }),
    ).toThrow(/body/);
    expect(() =>
      assertStaleDeliveryRejected({
        ...input,
        pending: { count: 1, pending: [{ meetingId }] },
      }),
    ).toThrow(/queue changed/);
  });

  test("accepts only two queued retries that leave one pending occurrence", () => {
    const meetingId = "qa-duplicate-delivery";
    const queued = { status: 202, body: { status: "queued" } };
    const input = {
      meetingId,
      deliveries: [queued, queued] as const,
      pending: { count: 1, pending: [{ meetingId }] } satisfies PendingPayload,
    };

    expect(() => assertDuplicateDeliveryIdempotent(input)).not.toThrow();
    expect(() =>
      assertDuplicateDeliveryIdempotent({
        ...input,
        deliveries: [queued, { ...queued, status: 400 }],
      }),
    ).toThrow(/202/);
    expect(() =>
      assertDuplicateDeliveryIdempotent({
        ...input,
        deliveries: [
          queued,
          { ...queued, body: { status: "queued", extra: true } },
        ],
      }),
    ).toThrow(/body/);
    expect(() =>
      assertDuplicateDeliveryIdempotent({
        ...input,
        pending: { count: 2, pending: [{ meetingId }, { meetingId }] },
      }),
    ).toThrow(/idempotent/);
  });

  test("accepts only a five-item burst that extends the exact pending set", () => {
    const originalMeetingId = "qa-happy-delivery";
    const burstMeetingIds = Array.from(
      { length: 5 },
      (_, index) => `qa-burst-${index}`,
    );
    const queued = { status: 202, body: { status: "queued" } };
    const input = {
      originalMeetingId,
      burstMeetingIds,
      deliveries: burstMeetingIds.map(() => queued),
      baseline: {
        count: 1,
        pending: [{ meetingId: originalMeetingId }],
      } satisfies PendingPayload,
      pending: {
        count: 6,
        pending: [originalMeetingId, ...burstMeetingIds].map((meetingId) => ({
          meetingId,
        })),
      } satisfies PendingPayload,
    };

    expect(() => assertBurstDeliveriesAcceptedExactlyOnce(input)).not.toThrow();
    expect(() =>
      assertBurstDeliveriesAcceptedExactlyOnce({
        ...input,
        deliveries: [{ ...queued, status: 429 }, ...input.deliveries.slice(1)],
      }),
    ).toThrow(/202/);
    expect(() =>
      assertBurstDeliveriesAcceptedExactlyOnce({
        ...input,
        deliveries: [
          { ...queued, body: { status: "queued", extra: true } },
          ...input.deliveries.slice(1),
        ],
      }),
    ).toThrow(/body/);
    expect(() =>
      assertBurstDeliveriesAcceptedExactlyOnce({
        ...input,
        baseline: {
          count: 2,
          pending: [
            { meetingId: originalMeetingId },
            { meetingId: "unexpected" },
          ],
        },
      }),
    ).toThrow(/baseline/);
    expect(() =>
      assertBurstDeliveriesAcceptedExactlyOnce({
        ...input,
        pending: {
          count: 6,
          pending: [
            originalMeetingId,
            ...burstMeetingIds.slice(0, 4),
            "extra",
          ].map((meetingId) => ({ meetingId })),
        },
      }),
    ).toThrow(/exact set/);
  });

  test("accepts only the exact CSRF rejection with config still enabled", () => {
    const input = {
      status: 403,
      body: {
        error: "csrf_rejected",
        message: "Missing or invalid X-Requested-With header",
      },
      config: { enabled: true, source: "fireflies" },
    };

    expect(() => assertMissingCompanionCsrfRejected(input)).not.toThrow();
    expect(() =>
      assertMissingCompanionCsrfRejected({ ...input, status: 200 }),
    ).toThrow(/403/);
    expect(() =>
      assertMissingCompanionCsrfRejected({
        ...input,
        body: { ...input.body, extra: true },
      }),
    ).toThrow(/body/);
    expect(() =>
      assertMissingCompanionCsrfRejected({
        ...input,
        config: { enabled: false, source: "fireflies" },
      }),
    ).toThrow(/config changed/);
  });

  test("configures before delegation and stops when config validation fails", async () => {
    const order: string[] = [];
    const validConfig = {
      enabled: true,
      source: "fireflies",
      url: "https://localhost:3014/api/connectors/webhooks/fireflies/token",
      secret: "one-time-secret",
    };

    const result = await configureWebhookBeforeDelegation({
      onConfigureAttempt: () => order.push("attempt"),
      configure: async () => {
        order.push("configure");
        return validConfig;
      },
      delegate: async () => {
        order.push("delegate");
        return "active";
      },
    });

    expect(order).toEqual(["attempt", "configure", "delegate"]);
    expect(result).toEqual({ config: validConfig, delegation: "active" });

    let invalidDelegationAttempted = false;
    await expect(
      configureWebhookBeforeDelegation({
        onConfigureAttempt: () => {},
        configure: async () => ({ ...validConfig, secret: null }),
        delegate: async () => {
          invalidDelegationAttempted = true;
          return "active";
        },
      }),
    ).rejects.toThrow(/enabled URL and one-time secret/);
    expect(invalidDelegationAttempted).toBe(false);
  });

  test("marks cleanup needed before a configure response is lost", async () => {
    let cleanupNeeded = false;
    let delegationAttempted = false;

    await expect(
      configureWebhookBeforeDelegation({
        onConfigureAttempt: () => {
          cleanupNeeded = true;
        },
        configure: async () => {
          throw new Error("configure response lost");
        },
        delegate: async () => {
          delegationAttempted = true;
          return "active";
        },
      }),
    ).rejects.toThrow(/response lost/);

    expect(cleanupNeeded).toBe(true);
    expect(delegationAttempted).toBe(false);
  });

  test("rejects an unsafe delivery config before delegation", async () => {
    const unsafeConfigs = [
      {
        enabled: true,
        source: "fireflies",
        url: "https://node.tinycloud.xyz/api/connectors/webhooks/fireflies/token",
        secret: "one-time-secret",
      },
      {
        enabled: true,
        source: "granola",
        url: "https://localhost:3014/api/connectors/webhooks/granola/token",
        secret: "one-time-secret",
      },
    ];

    for (const config of unsafeConfigs) {
      let delegationAttempted = false;
      await expect(
        configureWebhookBeforeDelegation({
          onConfigureAttempt: () => {},
          configure: async () => config,
          delegate: async () => {
            delegationAttempted = true;
            return "active";
          },
        }),
      ).rejects.toThrow(/loopback|source/);
      expect(delegationAttempted).toBe(false);
    }
  });
});

describe("Option-C live assertions", () => {
  const meetingId = "tinychat-webhook-qa-123";
  const before: ConnectorStorageCounts = { sql: 0, kv: 0 };
  const after: ConnectorStorageCounts = { sql: 0, kv: 0 };
  const pending: PendingPayload = {
    count: 1,
    pending: [{ meetingId }],
  };

  test("accepts a queued delivery that is surfaced, remains pending, and writes nothing", () => {
    expect(() =>
      assertOptionCHappyPath({
        meetingId,
        deliveryStatus: 202,
        deliveryBody: { status: "queued" },
        pending,
        drain: pending,
        afterDrainPending: pending,
        before,
        after,
      }),
    ).not.toThrow();
  });

  test("rejects a drain that carries a fail-closed surfaceBlocked marker", () => {
    expect(() =>
      assertOptionCHappyPath({
        meetingId,
        deliveryStatus: 202,
        deliveryBody: { status: "queued" },
        pending,
        drain: { ...pending, surfaceBlocked: "delegation_unusable" },
        afterDrainPending: pending,
        before,
        after,
      }),
    ).toThrow(/surfaceBlocked/);
  });

  test("rejects a drain that mutates connector SQL or KV", () => {
    expect(() =>
      assertOptionCHappyPath({
        meetingId,
        deliveryStatus: 202,
        deliveryBody: { status: "queued" },
        pending,
        drain: pending,
        afterDrainPending: pending,
        before,
        after: { sql: 1, kv: 0 },
      }),
    ).toThrow(/changed/);
  });
});
