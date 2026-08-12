import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import {
  REQUEST_HEADER_NAME,
  REQUEST_HEADER_VALUE,
  extractStoredSession,
  type PlaywrightStorageState,
} from "../real-auth-support.ts";

export interface ConnectorStorageCounts {
  sql: number;
  kv: number;
}

export interface PendingPayload {
  count: number;
  pending: Array<{ meetingId: string }>;
  surfaceBlocked?: string;
}

interface DelegationPermission {
  service: string;
  path: string;
  actions: readonly string[];
}

interface ConfigPayload {
  enabled: boolean;
  source: string | null;
  url: string | null;
  secret: string | null;
}

interface EnabledConfigPayload extends ConfigPayload {
  enabled: true;
  url: string;
  secret: string;
}

interface DelegationResult {
  status: string;
  expiresAt: string | null;
  prompted: boolean;
}

interface LiveCapabilityRequest {
  delegationTargets: Array<{
    did: string;
    permissions: DelegationPermission[];
  }>;
  [key: string]: unknown;
}

const APP_ID = "xyz.tinycloud.tinychat";
const SOURCE = "fireflies";
const CONNECTORS_DB = `${APP_ID}/connectors`;
const TRANSCRIPT_KV_PREFIX = `${APP_ID}/connectors/${SOURCE}/transcript/`;

export function assertLoopbackUrl(raw: string, label: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} URL must use HTTP(S)`);
  }
  if (
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1" &&
    url.hostname !== "[::1]"
  ) {
    throw new Error(`${label} URL must use a loopback host`);
  }
  return url;
}

export function webhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function invalidWebhookSignature(body: string, secret: string): string {
  const signature = webhookSignature(body, secret);
  const replacement = signature.endsWith("0") ? "1" : "0";
  return `${signature.slice(0, -1)}${replacement}`;
}

export function assertInvalidSignatureRejection(input: {
  meetingId: string;
  knownToken: {
    status: number;
    text: string;
    contentType: string | null;
    contentLength: string | null;
  };
  unknownToken: {
    status: number;
    text: string;
    contentType: string | null;
    contentLength: string | null;
  };
  pending: PendingPayload;
}): void {
  if (input.knownToken.status !== 401 || input.unknownToken.status !== 401) {
    throw new Error("invalid-signature deliveries did not both return 401");
  }
  const expectedBody = JSON.stringify({ error: "invalid_signature" });
  if (input.knownToken.text !== expectedBody) {
    throw new Error("invalid-signature delivery returned an unexpected body");
  }
  if (input.unknownToken.text !== input.knownToken.text) {
    throw new Error(
      "known and unknown tokens returned a different raw response",
    );
  }
  if (
    input.unknownToken.contentType !== input.knownToken.contentType ||
    input.unknownToken.contentLength !== input.knownToken.contentLength
  ) {
    throw new Error(
      "known and unknown tokens returned different response metadata",
    );
  }
  if (
    input.pending.count !== 0 ||
    containsMeeting(input.pending, input.meetingId)
  ) {
    throw new Error("invalid-signature delivery queue changed");
  }
}

export function assertUnsupportedEventIgnored(input: {
  meetingId: string;
  deliveryStatus: number;
  deliveryBody: unknown;
  pending: PendingPayload;
}): void {
  if (input.deliveryStatus !== 200) {
    throw new Error("unsupported-event delivery did not return 200");
  }
  const body = input.deliveryBody as Record<string, unknown> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    Object.keys(body).length !== 2 ||
    body.status !== "ignored" ||
    body.event !== "meeting.created"
  ) {
    throw new Error("unsupported-event delivery returned an unexpected body");
  }
  if (
    input.pending.count !== 0 ||
    containsMeeting(input.pending, input.meetingId)
  ) {
    throw new Error("unsupported-event delivery queue changed");
  }
}

export function assertStaleDeliveryRejected(input: {
  meetingId: string;
  deliveryStatus: number;
  deliveryBody: unknown;
  pending: PendingPayload;
}): void {
  if (input.deliveryStatus !== 400) {
    throw new Error("stale delivery did not return 400");
  }
  const body = input.deliveryBody as Record<string, unknown> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    Object.keys(body).length !== 1 ||
    body.error !== "stale_delivery"
  ) {
    throw new Error("stale delivery returned an unexpected body");
  }
  if (
    input.pending.count !== 0 ||
    containsMeeting(input.pending, input.meetingId)
  ) {
    throw new Error("stale delivery queue changed");
  }
}

export function assertDuplicateDeliveryIdempotent(input: {
  meetingId: string;
  deliveries: readonly [
    { status: number; body: unknown },
    { status: number; body: unknown },
  ];
  pending: PendingPayload;
}): void {
  for (const delivery of input.deliveries) {
    if (delivery.status !== 202) {
      throw new Error("duplicate delivery did not return 202");
    }
    const body = delivery.body as Record<string, unknown> | null;
    if (
      body === null ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      body.status !== "queued"
    ) {
      throw new Error("duplicate delivery returned an unexpected body");
    }
  }
  const occurrences = input.pending.pending.filter(
    (item) => item.meetingId === input.meetingId,
  ).length;
  if (
    input.pending.count !== 1 ||
    input.pending.pending.length !== 1 ||
    occurrences !== 1
  ) {
    throw new Error("duplicate delivery was not idempotent");
  }
}

export function assertBurstDeliveriesAcceptedExactlyOnce(input: {
  originalMeetingId: string;
  burstMeetingIds: readonly string[];
  deliveries: readonly { status: number; body: unknown }[];
  baseline: PendingPayload;
  pending: PendingPayload;
}): void {
  const burstIds = new Set(input.burstMeetingIds);
  if (
    input.burstMeetingIds.length !== 5 ||
    burstIds.size !== 5 ||
    burstIds.has(input.originalMeetingId)
  ) {
    throw new Error("burst meeting ids were not five distinct fresh ids");
  }
  if (input.deliveries.length !== 5) {
    throw new Error("burst did not return five delivery responses");
  }
  for (const delivery of input.deliveries) {
    if (delivery.status !== 202) {
      throw new Error("burst delivery did not return 202");
    }
    const body = delivery.body as Record<string, unknown> | null;
    if (
      body === null ||
      typeof body !== "object" ||
      Object.keys(body).length !== 1 ||
      body.status !== "queued"
    ) {
      throw new Error("burst delivery returned an unexpected body");
    }
  }
  if (
    input.baseline.count !== 1 ||
    input.baseline.pending.length !== 1 ||
    input.baseline.pending[0]?.meetingId !== input.originalMeetingId
  ) {
    throw new Error("burst pending baseline was not the original meeting only");
  }

  const expectedIds = new Set([
    input.originalMeetingId,
    ...input.burstMeetingIds,
  ]);
  const pendingIds = input.pending.pending.map((item) => item.meetingId);
  const actualIds = new Set(pendingIds);
  const exactSet =
    input.pending.count === expectedIds.size &&
    pendingIds.length === expectedIds.size &&
    actualIds.size === expectedIds.size &&
    [...expectedIds].every((meetingId) => actualIds.has(meetingId)) &&
    [...actualIds].every((meetingId) => expectedIds.has(meetingId));
  if (!exactSet) {
    throw new Error("burst pending queue did not contain the exact set");
  }
}

export function assertMissingCompanionCsrfRejected(input: {
  status: number;
  body: unknown;
  config: { enabled: boolean; source: string | null };
}): void {
  if (input.status !== 403) {
    throw new Error("missing companion CSRF header did not return 403");
  }
  const body = input.body as Record<string, unknown> | null;
  if (
    body === null ||
    typeof body !== "object" ||
    Object.keys(body).length !== 2 ||
    body.error !== "csrf_rejected" ||
    body.message !== "Missing or invalid X-Requested-With header"
  ) {
    throw new Error(
      "missing companion CSRF header returned an unexpected body",
    );
  }
  if (!input.config.enabled || input.config.source !== SOURCE) {
    throw new Error("missing companion CSRF config changed");
  }
}

export async function configureWebhookBeforeDelegation<T>(input: {
  onConfigureAttempt: () => void;
  configure: () => Promise<ConfigPayload>;
  delegate: () => Promise<T>;
}): Promise<{ config: EnabledConfigPayload; delegation: T }> {
  input.onConfigureAttempt();
  const config = await input.configure();
  if (!config.enabled || !config.url || !config.secret) {
    throw new Error(
      "webhook config mint did not return an enabled URL and one-time secret",
    );
  }
  if (config.source !== SOURCE) {
    throw new Error("webhook config mint returned unexpected source");
  }
  assertLoopbackUrl(config.url, "delivery");
  const delegation = await input.delegate();
  return {
    config: {
      ...config,
      enabled: true,
      url: config.url,
      secret: config.secret,
    },
    delegation,
  };
}

export function withoutProtocolBookkeepingPermissions<
  T extends DelegationPermission,
>(permissions: readonly T[]): T[] {
  return permissions.filter(
    (permission) =>
      !(
        permission.service === "tinycloud.capabilities" &&
        permission.path === "" &&
        permission.actions.length === 1 &&
        permission.actions[0] === "tinycloud.capabilities/read"
      ),
  );
}

export function assertOptionCHappyPath(input: {
  meetingId: string;
  deliveryStatus: number;
  deliveryBody: { status?: string };
  pending: PendingPayload;
  drain: PendingPayload;
  afterDrainPending: PendingPayload;
  before: ConnectorStorageCounts;
  after: ConnectorStorageCounts;
}): void {
  if (input.deliveryStatus !== 202 || input.deliveryBody.status !== "queued") {
    throw new Error("delivery did not return 202 with status queued");
  }

  for (const [label, payload] of [
    ["pending", input.pending],
    ["drain", input.drain],
    ["after-drain pending", input.afterDrainPending],
  ] as const) {
    if (Object.hasOwn(payload, "surfaceBlocked")) {
      throw new Error(`${label} unexpectedly included surfaceBlocked`);
    }
    if (!payload.pending.some((item) => item.meetingId === input.meetingId)) {
      throw new Error(`${label} did not contain meeting ${input.meetingId}`);
    }
  }

  if (
    input.before.sql !== input.after.sql ||
    input.before.kv !== input.after.kv
  ) {
    throw new Error(
      `connector storage changed: before sql=${input.before.sql} kv=${input.before.kv}; ` +
        `after sql=${input.after.sql} kv=${input.after.kv}`,
    );
  }
}

if (import.meta.main) {
  await run().catch((error) => {
    console.error(`webhook live QA failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function run(): Promise<void> {
  const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
  const backendUrl = baseUrl(
    process.env.WEBHOOK_QA_BACKEND_URL ?? "https://localhost:3014",
  );
  const frontendUrl = baseUrl(
    process.env.WEBHOOK_QA_FRONTEND_URL ?? "https://localhost:5199",
  );
  const profileDir = resolve(
    process.env.WEBHOOK_QA_PROFILE_DIR ??
      "/Users/roman/Documents/GitHub/tinychat-connectors-wt/test/.auth/connectors-profile",
  );
  const timeoutMs = positiveInt(process.env.WEBHOOK_QA_TIMEOUT_MS, 120_000);

  assertLoopbackUrl(backendUrl, "backend");
  assertLoopbackUrl(frontendUrl, "frontend");

  const evidenceDir = join(
    repoRoot,
    "test/.auth/evidence",
    `webhook-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  mkdirSync(evidenceDir, { recursive: true });

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let sessionToken: string | null = null;
  let delegationAccepted = false;
  let configCleanupNeeded = false;
  let cleanupStatus: number | null = null;

  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: "chrome",
      headless: true,
    });
    page = context.pages()[0] ?? (await context.newPage());

    let observedDelegationStatus: number | null = null;
    page.on("response", (response) => {
      if (
        response.request().method() === "POST" &&
        response.url() === `${backendUrl}/api/delegations`
      ) {
        observedDelegationStatus = response.status();
      }
    });

    await page.goto(`${frontendUrl}/chat`, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForFunction(
      () => Boolean((window as unknown as { __tcw?: unknown }).__tcw),
      undefined,
      { timeout: timeoutMs },
    );

    const stored = extractStoredSession(
      (await context.storageState()) as PlaywrightStorageState,
    );
    if (!stored || stored.expiresAt <= Date.now() + 30_000) {
      throw new Error(
        "the browser profile does not contain a live application-created session",
      );
    }
    sessionToken = stored.token;

    const existing = await companionRequest<ConfigPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/config" },
    );
    if (existing.enabled) {
      throw new Error(
        "the scratch identity already has webhooks enabled; use a clean QA space",
      );
    }

    const clientModuleUrl = `${frontendUrl}/@fs${repoRoot}/packages/client/src/index.ts`;
    const { config, delegation } = await configureWebhookBeforeDelegation({
      onConfigureAttempt: () => {
        configCleanupNeeded = true;
      },
      configure: async () => {
        return companionRequest<ConfigPayload>(page, backendUrl, sessionToken, {
          path: "/api/connectors/webhooks/config",
          method: "POST",
          body: { source: SOURCE },
        });
      },
      delegate: async () => {
        const composed = (await page.evaluate(
          async ({ backendUrl: api, clientModuleUrl: moduleUrl }) => {
            const client = await import(moduleUrl);
            const [manifest, infoResponse] = await Promise.all([
              client.loadAppManifest(`${api}/api/manifest`),
              fetch(`${api}/api/server-info`),
            ]);
            if (!infoResponse.ok) {
              throw new Error(
                `server-info request failed (${infoResponse.status})`,
              );
            }
            const info = await infoResponse.json();
            return {
              backendDid: info.did,
              request: client.composeManifestWithBackend(manifest, info),
            };
          },
          { backendUrl, clientModuleUrl },
        )) as { backendDid: string; request: LiveCapabilityRequest };
        const request = {
          ...composed.request,
          delegationTargets: composed.request.delegationTargets.map(
            (target) => ({
              ...target,
              permissions: withoutProtocolBookkeepingPermissions(
                target.permissions,
              ),
            }),
          ),
        };
        const accepted = (await page.evaluate(
          async ({
            backendUrl: api,
            backendDid,
            moduleUrl,
            request,
            token,
          }) => {
            const tcw = (window as unknown as { __tcw?: unknown }).__tcw;
            if (!tcw) throw new Error("window.__tcw is unavailable");
            const client = await import(moduleUrl);
            const created = await client.createManifestDelegation(
              tcw,
              backendDid,
              request,
            );
            const delegated = await client.sendDelegation(
              api,
              created.serialized,
              token,
            );
            return {
              status: delegated.status,
              expiresAt: delegated.expiresAt ?? null,
              prompted: created.prompted,
            };
          },
          {
            backendUrl,
            backendDid: composed.backendDid,
            moduleUrl: clientModuleUrl,
            request,
            token: sessionToken,
          },
        )) as DelegationResult;
        delegationAccepted =
          accepted.status === "active" && observedDelegationStatus === 200;
        if (!delegationAccepted) {
          throw new Error(
            "the normal POST /api/delegations acceptance path was not observed as active",
          );
        }
        if (accepted.prompted) {
          throw new Error(
            "delegation unexpectedly required a new permission ceremony",
          );
        }
        return accepted;
      },
    });

    const missingCompanionCsrf = (await page.evaluate(
      async ({ backendUrl: api, token }) => {
        const response = await fetch(`${api}/api/connectors/webhooks/config`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        return { status: response.status, body: await response.json() };
      },
      { backendUrl, token: sessionToken },
    )) as { status: number; body: unknown };
    const configAfterMissingCompanionCsrf =
      await companionRequest<ConfigPayload>(page, backendUrl, sessionToken, {
        path: "/api/connectors/webhooks/config",
      });
    assertMissingCompanionCsrfRejected({
      status: missingCompanionCsrf.status,
      body: missingCompanionCsrf.body,
      config: {
        enabled: configAfterMissingCompanionCsrf.enabled,
        source: configAfterMissingCompanionCsrf.source,
      },
    });
    const csrfSourceUnchanged =
      configAfterMissingCompanionCsrf.source === SOURCE;
    console.log(
      `missing companion CSRF: status=${missingCompanionCsrf.status} ` +
        `error=csrf_rejected config-enabled=${configAfterMissingCompanionCsrf.enabled} ` +
        `source-unchanged=${csrfSourceUnchanged}`,
    );

    const invalidMeetingId = `tinychat-webhook-invalid-signature-${Date.now().toString(36)}`;
    const invalidBody = JSON.stringify({
      meeting_id: invalidMeetingId,
      event: "meeting.transcribed",
      timestamp: new Date().toISOString(),
    });
    const invalidSignature = invalidWebhookSignature(
      invalidBody,
      config.secret,
    );
    const unknownDeliveryUrl = new URL(config.url);
    unknownDeliveryUrl.pathname = `${unknownDeliveryUrl.pathname.slice(
      0,
      unknownDeliveryUrl.pathname.lastIndexOf("/") + 1,
    )}${randomBytes(32).toString("base64url")}`;
    assertLoopbackUrl(unknownDeliveryUrl.href, "unknown-token delivery");
    if (unknownDeliveryUrl.href === config.url) {
      throw new Error("failed to generate a fresh unknown webhook token");
    }

    const invalidDeliveries = await page.evaluate(
      async ({ body: rawBody, knownUrl, signature, unknownUrl }) => {
        const send = async (url: string) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature": signature,
            },
            body: rawBody,
          });
          return {
            status: response.status,
            text: await response.text(),
            contentType: response.headers.get("content-type"),
            contentLength: response.headers.get("content-length"),
          };
        };
        return {
          knownToken: await send(knownUrl),
          unknownToken: await send(unknownUrl),
        };
      },
      {
        body: invalidBody,
        knownUrl: config.url,
        signature: invalidSignature,
        unknownUrl: unknownDeliveryUrl.href,
      },
    );
    const afterInvalidPending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    assertInvalidSignatureRejection({
      meetingId: invalidMeetingId,
      knownToken: invalidDeliveries.knownToken,
      unknownToken: invalidDeliveries.unknownToken,
      pending: afterInvalidPending,
    });
    console.log(
      `invalid signature: known=${invalidDeliveries.knownToken.status} ` +
        `unknown=${invalidDeliveries.unknownToken.status} ` +
        `pending=${afterInvalidPending.count}; raw-equal=true metadata-equal=true`,
    );

    const unsupportedMeetingId = `tinychat-webhook-unsupported-event-${Date.now().toString(36)}`;
    const unsupportedBody = JSON.stringify({
      meeting_id: unsupportedMeetingId,
      event: "meeting.created",
      timestamp: new Date().toISOString(),
    });
    const unsupportedSignature = webhookSignature(
      unsupportedBody,
      config.secret,
    );
    const unsupportedDelivery = (await page.evaluate(
      async ({ body: rawBody, signature, url }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature": signature,
          },
          body: rawBody,
        });
        return { status: response.status, body: await response.json() };
      },
      {
        body: unsupportedBody,
        signature: unsupportedSignature,
        url: config.url,
      },
    )) as { status: number; body: unknown };
    const afterUnsupportedPending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    assertUnsupportedEventIgnored({
      meetingId: unsupportedMeetingId,
      deliveryStatus: unsupportedDelivery.status,
      deliveryBody: unsupportedDelivery.body,
      pending: afterUnsupportedPending,
    });
    console.log(
      `unsupported event: status=${unsupportedDelivery.status} body=ignored ` +
        `pending=${afterUnsupportedPending.count} queued=false`,
    );

    const staleMeetingId = `tinychat-webhook-stale-delivery-${Date.now().toString(36)}`;
    const staleBody = JSON.stringify({
      meeting_id: staleMeetingId,
      event: "meeting.transcribed",
      timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });
    const staleSignature = webhookSignature(staleBody, config.secret);
    const staleDelivery = (await page.evaluate(
      async ({ body: rawBody, signature, url }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature": signature,
          },
          body: rawBody,
        });
        return { status: response.status, body: await response.json() };
      },
      { body: staleBody, signature: staleSignature, url: config.url },
    )) as { status: number; body: unknown };
    const afterStalePending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    assertStaleDeliveryRejected({
      meetingId: staleMeetingId,
      deliveryStatus: staleDelivery.status,
      deliveryBody: staleDelivery.body,
      pending: afterStalePending,
    });
    console.log(
      `stale delivery: status=${staleDelivery.status} body=stale_delivery ` +
        `pending=${afterStalePending.count} queued=false`,
    );

    const before = await connectorStorageCounts(page);
    const meetingId = `tinychat-webhook-live-${Date.now().toString(36)}`;
    const body = JSON.stringify({
      meeting_id: meetingId,
      event: "meeting.transcribed",
      timestamp: new Date().toISOString(),
    });
    const signature = webhookSignature(body, config.secret);
    const delivery = (await page.evaluate(
      async ({ body: rawBody, signature: header, url }) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature": header,
          },
          body: rawBody,
        });
        return { status: response.status, body: await response.json() };
      },
      { body, signature, url: config.url },
    )) as { status: number; body: { status?: string } };

    await page.waitForTimeout(3_000);
    const pending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    const drain = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      {
        path: "/api/connectors/webhooks/drain",
        method: "POST",
      },
    );
    await page.waitForTimeout(2_100);
    const afterDrainPending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    const after = await connectorStorageCounts(page);

    console.log(
      `pending counts: get=${pending.count} drain=${drain.count} after=${afterDrainPending.count}; ` +
        `blocked=${pending.surfaceBlocked ?? "none"}/${drain.surfaceBlocked ?? "none"}/${afterDrainPending.surfaceBlocked ?? "none"}`,
    );

    assertOptionCHappyPath({
      meetingId,
      deliveryStatus: delivery.status,
      deliveryBody: delivery.body,
      pending,
      drain,
      afterDrainPending,
      before,
      after,
    });

    const duplicateDeliveries = (await page.evaluate(
      async ({ body: rawBody, signature: header, url }) => {
        const responses: Array<{ status: number; body: unknown }> = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-hub-signature": header,
            },
            body: rawBody,
          });
          responses.push({
            status: response.status,
            body: await response.json(),
          });
        }
        return responses;
      },
      { body, signature, url: config.url },
    )) as [
      { status: number; body: unknown },
      { status: number; body: unknown },
    ];
    await page.waitForTimeout(1_000);
    const afterDuplicatePending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    assertDuplicateDeliveryIdempotent({
      meetingId,
      deliveries: duplicateDeliveries,
      pending: afterDuplicatePending,
    });
    const duplicateOccurrenceCount = afterDuplicatePending.pending.filter(
      (item) => item.meetingId === meetingId,
    ).length;
    console.log(
      `duplicate delivery: statuses=${duplicateDeliveries[0].status}/${duplicateDeliveries[1].status} ` +
        `bodies=queued/queued pending=${afterDuplicatePending.count} ` +
        `occurrences=${duplicateOccurrenceCount} idempotent=true`,
    );

    const burstTimestamp = Date.now();
    const burstFixtures = Array.from({ length: 5 }, (_, index) => {
      const burstMeetingId = `tinychat-webhook-burst-${burstTimestamp.toString(36)}-${index}`;
      const burstBody = JSON.stringify({
        meeting_id: burstMeetingId,
        event: "meeting.transcribed",
        timestamp: new Date(burstTimestamp + index).toISOString(),
      });
      return {
        meetingId: burstMeetingId,
        body: burstBody,
        signature: webhookSignature(burstBody, config.secret),
      };
    });
    const burstMeetingIds = burstFixtures.map((fixture) => fixture.meetingId);
    const burstDeliveries = (await page.evaluate(
      async ({ fixtures, url }) => {
        return Promise.all(
          fixtures.map(async (fixture) => {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-hub-signature": fixture.signature,
              },
              body: fixture.body,
            });
            return { status: response.status, body: await response.json() };
          }),
        );
      },
      { fixtures: burstFixtures, url: config.url },
    )) as Array<{ status: number; body: unknown }>;
    await page.waitForTimeout(1_000);
    const afterBurstPending = await companionRequest<PendingPayload>(
      page,
      backendUrl,
      sessionToken,
      { path: "/api/connectors/webhooks/pending" },
    );
    assertBurstDeliveriesAcceptedExactlyOnce({
      originalMeetingId: meetingId,
      burstMeetingIds,
      deliveries: burstDeliveries,
      baseline: afterDuplicatePending,
      pending: afterBurstPending,
    });
    const burstUniqueCount = new Set(
      afterBurstPending.pending.map((item) => item.meetingId),
    ).size;
    console.log(
      `burst delivery: size=${burstMeetingIds.length} all-accepted=true ` +
        `pending=${afterDuplicatePending.count}->${afterBurstPending.count} ` +
        `delta=${afterBurstPending.count - afterDuplicatePending.count} ` +
        `unique=${burstUniqueCount} exact-set=true`,
    );

    const evidence = {
      timestamp: new Date().toISOString(),
      meetingId,
      browserSession: "application-created",
      newOperatorSignInRequired: false,
      delegation: {
        postObserved: true,
        status: delegation.status,
        expiresAt: delegation.expiresAt,
        prompted: delegation.prompted,
      },
      missingCompanionCsrf: {
        status: missingCompanionCsrf.status,
        error: "csrf_rejected",
        configEnabled: configAfterMissingCompanionCsrf.enabled,
        sourceUnchanged: csrfSourceUnchanged,
      },
      invalidSignature: {
        meetingId: invalidMeetingId,
        knownTokenStatus: invalidDeliveries.knownToken.status,
        unknownTokenStatus: invalidDeliveries.unknownToken.status,
        bodyError: "invalid_signature",
        rawResponseEqual:
          invalidDeliveries.knownToken.text ===
          invalidDeliveries.unknownToken.text,
        contentTypeEqual:
          invalidDeliveries.knownToken.contentType ===
          invalidDeliveries.unknownToken.contentType,
        contentLengthEqual:
          invalidDeliveries.knownToken.contentLength ===
          invalidDeliveries.unknownToken.contentLength,
        pendingCount: afterInvalidPending.count,
        meetingQueued: containsMeeting(afterInvalidPending, invalidMeetingId),
      },
      unsupportedEvent: {
        meetingId: unsupportedMeetingId,
        status: unsupportedDelivery.status,
        bodyStatus: "ignored",
        pendingCount: afterUnsupportedPending.count,
        meetingQueued: containsMeeting(
          afterUnsupportedPending,
          unsupportedMeetingId,
        ),
      },
      staleDelivery: {
        meetingId: staleMeetingId,
        status: staleDelivery.status,
        bodyError: "stale_delivery",
        pendingCount: afterStalePending.count,
        meetingQueued: containsMeeting(afterStalePending, staleMeetingId),
      },
      duplicateDelivery: {
        meetingId,
        statuses: duplicateDeliveries.map((item) => item.status),
        bodyStatuses: ["queued", "queued"],
        pendingCount: afterDuplicatePending.count,
        occurrenceCount: duplicateOccurrenceCount,
        idempotent: true,
      },
      burstDelivery: {
        meetingIds: burstMeetingIds,
        size: burstMeetingIds.length,
        allAccepted: true,
        baselineCount: afterDuplicatePending.count,
        finalCount: afterBurstPending.count,
        deltaCount: afterBurstPending.count - afterDuplicatePending.count,
        uniqueCount: burstUniqueCount,
        exactSet: true,
      },
      delivery: { status: delivery.status, bodyStatus: delivery.body.status },
      pending: {
        count: pending.count,
        containsMeeting: containsMeeting(pending, meetingId),
      },
      drain: {
        count: drain.count,
        containsMeeting: containsMeeting(drain, meetingId),
      },
      afterDrainPending: {
        count: afterDrainPending.count,
        containsMeeting: containsMeeting(afterDrainPending, meetingId),
      },
      storage: {
        before,
        after,
        unchanged: before.sql === after.sql && before.kv === after.kv,
      },
    };
    const evidencePath = join(evidenceDir, "result.json");
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });

    console.log(`meeting id: ${meetingId}`);
    console.log(`evidence: ${evidencePath}`);
    console.log(
      "webhook live QA passed: queued, surfaced, retained, and no user-space write",
    );
  } finally {
    if (page && sessionToken) {
      const cleanupPath = configCleanupNeeded
        ? "/api/connectors/webhooks/config"
        : delegationAccepted
          ? "/api/delegations"
          : null;
      if (cleanupPath) {
        cleanupStatus = await companionStatus(
          page,
          backendUrl,
          sessionToken,
          cleanupPath,
          "DELETE",
        ).catch(() => null);
      }
    }
    await context?.close().catch(() => {});
    if ((configCleanupNeeded || delegationAccepted) && cleanupStatus !== 200) {
      console.warn(
        "cleanup did not complete; inspect the scratch identity before reusing it",
      );
    }
  }
}

async function companionRequest<T>(
  page: Page,
  backendUrl: string,
  token: string,
  input: { path: string; method?: string; body?: unknown },
): Promise<T> {
  const result = await page.evaluate(
    async ({
      backendUrl: api,
      body,
      method,
      path,
      requestHeaderName,
      requestHeaderValue,
      token,
    }) => {
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          [requestHeaderName]: requestHeaderValue,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let parsed: unknown;
      if (!text) parsed = null;
      else {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      return { ok: response.ok, status: response.status, body: parsed };
    },
    {
      backendUrl,
      body: input.body,
      method: input.method ?? "GET",
      path: input.path,
      requestHeaderName: REQUEST_HEADER_NAME,
      requestHeaderValue: REQUEST_HEADER_VALUE,
      token,
    },
  );
  if (!result.ok) {
    throw new Error(
      `companion request ${input.method ?? "GET"} ${input.path} failed (${result.status})`,
    );
  }
  return result.body as T;
}

async function companionStatus(
  page: Page,
  backendUrl: string,
  token: string,
  path: string,
  method: string,
): Promise<number> {
  return page.evaluate(
    async ({
      backendUrl: api,
      method,
      path,
      requestHeaderName,
      requestHeaderValue,
      token,
    }) => {
      const response = await fetch(`${api}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          [requestHeaderName]: requestHeaderValue,
        },
      });
      return response.status;
    },
    {
      backendUrl,
      method,
      path,
      requestHeaderName: REQUEST_HEADER_NAME,
      requestHeaderValue: REQUEST_HEADER_VALUE,
      token,
    },
  );
}

async function connectorStorageCounts(
  page: Page,
): Promise<ConnectorStorageCounts> {
  return page.evaluate(
    async ({ dbName, kvPrefix, source }) => {
      const tcw = (
        window as unknown as {
          __tcw?: {
            sql: {
              db(name: string): {
                query(
                  sql: string,
                  params?: unknown[],
                ): Promise<{
                  ok: boolean;
                  data?: { rows?: unknown[][] };
                  error?: { message?: string };
                }>;
              };
            };
            kv: {
              list(input: { path: string }): Promise<{
                ok: boolean;
                data?: { keys?: string[] };
                error?: { message?: string };
              }>;
            };
          };
        }
      ).__tcw;
      if (!tcw) throw new Error("window.__tcw is unavailable");

      const rows = await tcw.sql
        .db(dbName)
        .query("SELECT source_id FROM connector_meeting WHERE source = ?", [
          source,
        ]);
      if (!rows.ok) {
        throw new Error(
          `connector SQL probe failed: ${rows.error?.message ?? "unknown"}`,
        );
      }

      const keys = await tcw.kv.list({ path: kvPrefix });
      if (!keys.ok) {
        throw new Error(
          `connector KV probe failed: ${keys.error?.message ?? "unknown"}`,
        );
      }
      return {
        sql: rows.data?.rows?.length ?? 0,
        kv: (keys.data?.keys ?? []).filter((key) => key.includes(kvPrefix))
          .length,
      };
    },
    { dbName: CONNECTORS_DB, kvPrefix: TRANSCRIPT_KV_PREFIX, source: SOURCE },
  );
}

function containsMeeting(payload: PendingPayload, meetingId: string): boolean {
  return payload.pending.some((item) => item.meetingId === meetingId);
}

function baseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
