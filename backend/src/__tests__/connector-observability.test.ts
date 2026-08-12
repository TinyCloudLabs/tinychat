import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import express from "express";

import {
  CALLER_SAFE_ERRORS,
  DLQ_DEPTH_THRESHOLD,
  DLQ_GROWTH_THRESHOLD,
  GENERIC_CALLER_ERROR,
  IngestObservabilityReporter,
  OBSERVABILITY_LOG_PREFIX,
  callerFacingError,
  collectIngestObservability,
  evaluateIngestAlerts,
  ingestObservabilityCounters,
  isCallerSafeError,
  recordCredentialAudit,
  recordReconcileLag,
  _resetIngestObservability,
  type IngestObservabilitySnapshot,
} from "../services/ingest-observability.js";
import {
  CONTENT_MASTER_ENV,
  ContentStore,
  InMemoryContentBlobStore,
  _resetContentMasterCache,
} from "../services/content-store.js";
import {
  CREDENTIAL_MASTER_ENV,
  CredentialStore,
  InMemoryCredentialRowStore,
  type CredentialRow,
  type CredentialRowStore,
  type CredentialSecret,
} from "../services/credential-store.js";
import {
  FETCH_SLA_MS,
  type FetchWorkerStats,
} from "../services/fetch-worker.js";
import type { ContentStoreStats } from "../services/content-store.js";
import type { DeadItem } from "../services/connector-queue.js";
import {
  createIngestOnDelivery,
  _resetFetchWorkerNudge,
} from "../services/ingest-nudge.js";
import { createConnectorMeetingsRouter } from "../routes/connector-meetings.js";
import {
  createConnectorCredentialRouter,
  type ConnectorOAuthPort,
} from "../routes/connector-credentials.js";
import type { IngestMode } from "../services/ingest-mode.js";
import {
  redactedErrorMessage,
  _resetWebhookTokenState,
} from "../services/webhook-tokens.js";

/**
 * W8 — OBSERVABILITY + REDACTION (backend-ingest plan §8.1 W8; §8.2 delta item 9;
 * §9 anti-pattern 7).
 *
 * Every test here is tagged `[delta-09]`, whose acceptance sentence is the checklist this file
 * works through literally:
 *
 *     Error-path log capture contains no raw address, no credential, ids hashed; caller-facing
 *     errors are generic; DLQ depth visible in an operator surface.
 *
 * Plus W8's own contents row: *counters for deliveries, fetch ok/fail, DLQ depth, overflow drops,
 * reconcile lag and the credential-op audit, with alert thresholds for DLQ growth and SLA breach.*
 *
 * The structural claim the suite leans on hardest is that the snapshot is **numbers only**. A
 * counter that can hold a string is a counter that can hold an address, a meeting id or a
 * credential — the anti-pattern 7 failure is not "someone logged a secret on purpose", it is
 * "someone put an identifier in a diagnostic and the diagnostic went to a `public_logs=true`
 * stream". Numbers cannot carry an identifier, so the redaction is by construction and the test
 * for it is total rather than a sample.
 */

const ORIGINAL_ENV = { ...process.env };

const SOURCE = "fireflies";
const ADDRESS_A = "0x7d033300000000000000000000000000000073f2";
const ADDRESS_B = "0xb1b1b10000000000000000000000000000001111";
const CONTENT_MASTER = "R29vZE1hc3RlckZvckNvbnRlbnRFbnZlbG9wZXNBQTA9";
const CREDENTIAL_MASTER = "Zk9pQ2xUb0FzRHZFcldxTnBZeEhtQjNnU2o1dDBjMD0=";
const LOG_SALT = "aQ2wS3eD4rF5tG6yH7uJ8iK9oL0pZ1xC2vB3nM4kJ5h=";

/** Never a log line, never a response body, never a counter. */
const SECRET_A = "ff-access-token-AAAA-1111";
const MEETING_ID = "01JQZMEETINGIDAAAA0001";
const TRANSCRIPT_TEXT = "so about the Q3 layoffs — Dana said the legal review is blocking";

const T0 = Date.parse("2026-08-10T12:00:00.000Z");

beforeEach(() => {
  _resetWebhookTokenState();
  _resetContentMasterCache();
  _resetIngestObservability();
  _resetFetchWorkerNudge();
  process.env.LOG_HASH_SALT = LOG_SALT;
  process.env[CONTENT_MASTER_ENV] = CONTENT_MASTER;
  process.env[CREDENTIAL_MASTER_ENV] = CREDENTIAL_MASTER;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _resetWebhookTokenState();
  _resetContentMasterCache();
  _resetIngestObservability();
  _resetFetchWorkerNudge();
});

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const record = (...args: unknown[]) => {
    lines.push(
      args.map((a) => (typeof a === "string" ? a : String(a))).join(" "),
    );
  };
  console.log = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

function workerStats(
  overrides: Partial<FetchWorkerStats> = {},
): FetchWorkerStats {
  return {
    passes: 0,
    claimed: 0,
    fetched: 0,
    failed: 0,
    deadLettered: 0,
    tombstoned: 0,
    rateLimited: 0,
    timeouts: 0,
    storeFailures: 0,
    credentialUnavailable: 0,
    errors: 0,
    slaBreaches: 0,
    p95LagMs: 0,
    peakUpstreamConcurrency: 0,
    ...overrides,
  };
}

function contentStats(
  overrides: Partial<ContentStoreStats> = {},
): ContentStoreStats {
  return {
    created: 0,
    merged: 0,
    droppedOverflow: 0,
    rejectedTooLarge: 0,
    tombstoneRefusals: 0,
    purgeRefusals: 0,
    writeFailures: 0,
    swept: 0,
    reconciled: 0,
    ...overrides,
  };
}

/**
 * The dead-letter surface the collector reads, instrumented for the two things that matter:
 * how many concurrent reads it saw (TinyCloud drops concurrent responses on one space, so the
 * collector must walk the cohort sequentially) and which tenants it was asked about.
 */
class DeadLetterProbe {
  concurrent = 0;
  peakConcurrent = 0;
  readonly asked: string[] = [];
  failFor = new Set<string>();

  constructor(private readonly depths: Map<string, number>) {}

  async dead(source: string, address: string): Promise<DeadItem[]> {
    this.asked.push(`${source} ${address.toLowerCase()}`);
    this.concurrent += 1;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      if (this.failFor.has(address.toLowerCase())) {
        throw new Error(`dead-letter read failed for ${address}`);
      }
      const depth = this.depths.get(address.toLowerCase()) ?? 0;
      return Array.from({ length: depth }, (_, index) => ({
        meetingId: `${MEETING_ID}-${index}`,
        kind: "transcript" as const,
        receivedAt: new Date(T0).toISOString(),
        attempts: 5,
        lastError: "upstream_error",
        deadAt: new Date(T0).toISOString(),
      })) as unknown as DeadItem[];
    } finally {
      this.concurrent -= 1;
    }
  }
}

/** Every leaf of the snapshot, flattened — the total form of "numbers only". */
function leaves(value: unknown, path = "$"): Array<{ path: string; value: unknown }> {
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) =>
      leaves(entry, `${path}.${key}`),
    );
  }
  return [{ path, value }];
}

describe("W8 — counters (plan §8.1 W8)", () => {
  test("[delta-09] the snapshot is numbers only: a counter cannot carry an address, a meeting id or a credential", async () => {
    const probe = new DeadLetterProbe(new Map([[ADDRESS_A.toLowerCase(), 3]]));
    const snapshot = await collectIngestObservability({
      worker: () => workerStats({ fetched: 7, failed: 2, deadLettered: 3 }),
      content: () => contentStats({ droppedOverflow: 4, reconciled: 1 }),
      deadLetters: probe,
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
      nudge: () => ({ nudged: 9, skipped: 2, noWorker: 1, errors: 1 }),
    });

    const all = leaves(snapshot);
    expect(all.length).toBeGreaterThan(10);
    for (const leaf of all) {
      expect(`${leaf.path}=${typeof leaf.value}`).toBe(`${leaf.path}=number`);
      expect(Number.isFinite(leaf.value as number)).toBe(true);
    }

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(ADDRESS_A);
    expect(serialized).not.toContain(ADDRESS_A.toLowerCase());
    expect(serialized).not.toContain(MEETING_ID);
    expect(serialized).not.toContain(SECRET_A);
  });

  test("[delta-09] every W8 counter is present: deliveries, fetch ok/fail, DLQ depth, overflow drops, reconcile lag, credential-op audit", async () => {
    recordReconcileLag(90_000);
    recordCredentialAudit("op=credential-store result=ok source=fireflies aid=abc");

    const probe = new DeadLetterProbe(
      new Map([
        [ADDRESS_A.toLowerCase(), 2],
        [ADDRESS_B.toLowerCase(), 1],
      ]),
    );
    const snapshot = await collectIngestObservability({
      worker: () =>
        workerStats({ fetched: 7, failed: 2, deadLettered: 3, p95LagMs: 1_000 }),
      content: () =>
        contentStats({ droppedOverflow: 4, rejectedTooLarge: 1, reconciled: 1 }),
      deadLetters: probe,
      cohort: async () =>
        new Set([ADDRESS_A.toLowerCase(), ADDRESS_B.toLowerCase()]),
      sources: [SOURCE],
      nudge: () => ({ nudged: 9, skipped: 2, noWorker: 1, errors: 1 }),
    });

    // deliveries = every delivery the seam saw, cohort or not.
    expect(snapshot.deliveries).toBe(13);
    expect(snapshot.nudged).toBe(9);
    expect(snapshot.fetchOk).toBe(7);
    // fail = requeued + dead-lettered; the three dispositions partition the claimed items.
    expect(snapshot.fetchFail).toBe(5);
    expect(snapshot.deadLettered).toBe(3);
    expect(snapshot.dlqDepth).toBe(3);
    expect(snapshot.dlqUnreadable).toBe(0);
    expect(snapshot.overflowDrops).toBe(5);
    expect(snapshot.reconcileLagP95Ms).toBe(90_000);
    expect(snapshot.fetchLagP95Ms).toBe(1_000);
    expect(snapshot.credentialOps.store).toBe(1);
    expect(snapshot.credentialOps.total).toBe(1);
    expect(snapshot.cohortSize).toBe(2);
  });

  test("[delta-09] DLQ depth is read one tenant at a time — never concurrently on one space", async () => {
    const probe = new DeadLetterProbe(
      new Map([
        [ADDRESS_A.toLowerCase(), 2],
        [ADDRESS_B.toLowerCase(), 4],
      ]),
    );
    const snapshot = await collectIngestObservability({
      deadLetters: probe,
      cohort: async () =>
        new Set([ADDRESS_A.toLowerCase(), ADDRESS_B.toLowerCase()]),
      sources: [SOURCE],
    });

    expect(snapshot.dlqDepth).toBe(6);
    expect(probe.peakConcurrent).toBe(1);
    expect(probe.asked).toHaveLength(2);
  });

  test("[delta-09] an unreadable dead-letter is COUNTED, never reported as depth zero", async () => {
    const probe = new DeadLetterProbe(
      new Map([
        [ADDRESS_A.toLowerCase(), 2],
        [ADDRESS_B.toLowerCase(), 4],
      ]),
    );
    probe.failFor.add(ADDRESS_B.toLowerCase());

    const capture = captureLogs();
    let snapshot: IngestObservabilitySnapshot;
    try {
      snapshot = await collectIngestObservability({
        deadLetters: probe,
        cohort: async () =>
          new Set([ADDRESS_A.toLowerCase(), ADDRESS_B.toLowerCase()]),
        sources: [SOURCE],
      });
    } finally {
      capture.restore();
    }

    // The readable tenant still contributes; the unreadable one is a counted floor.
    expect(snapshot.dlqDepth).toBe(2);
    expect(snapshot.dlqUnreadable).toBe(1);
    expect(evaluateIngestAlerts(snapshot).map((a) => a.code)).toContain(
      "dlq_unreadable",
    );
    expect(capture.lines.join("\n")).not.toContain(ADDRESS_B);
  });

  test("[delta-09] an unreadable cohort is counted, and the collector never throws into its caller", async () => {
    const snapshot = await collectIngestObservability({
      deadLetters: new DeadLetterProbe(new Map()),
      cohort: async () => {
        throw new Error(`cohort unreadable for ${ADDRESS_A}`);
      },
      sources: [SOURCE],
    });

    expect(snapshot.cohortSize).toBe(0);
    expect(snapshot.dlqUnreadable).toBeGreaterThan(0);
  });
});

describe("W8 — alert thresholds (plan §8.1 W8: DLQ growth + SLA breach)", () => {
  test("[delta-09] DLQ growth past the threshold raises an alert", async () => {
    const base = await collectIngestObservability({
      deadLetters: new DeadLetterProbe(new Map([[ADDRESS_A.toLowerCase(), 1]])),
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });
    const grown = await collectIngestObservability({
      deadLetters: new DeadLetterProbe(
        new Map([[ADDRESS_A.toLowerCase(), 1 + DLQ_GROWTH_THRESHOLD + 1]]),
      ),
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });

    expect(evaluateIngestAlerts(base, base).map((a) => a.code)).not.toContain(
      "dlq_growth",
    );
    const alerts = evaluateIngestAlerts(grown, base);
    const growth = alerts.find((a) => a.code === "dlq_growth");
    expect(growth).toBeDefined();
    expect(growth!.value).toBe(DLQ_GROWTH_THRESHOLD + 1);
    expect(growth!.threshold).toBe(DLQ_GROWTH_THRESHOLD);
  });

  test("[delta-09] a standing DLQ deeper than the threshold alerts even without growth", async () => {
    const deep = await collectIngestObservability({
      deadLetters: new DeadLetterProbe(
        new Map([[ADDRESS_A.toLowerCase(), DLQ_DEPTH_THRESHOLD + 1]]),
      ),
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });
    expect(evaluateIngestAlerts(deep, deep).map((a) => a.code)).toContain(
      "dlq_depth",
    );
  });

  test("[delta-09] an SLA breach alerts — both the counted breach and a p95 past the SLA", async () => {
    const breached = await collectIngestObservability({
      worker: () => workerStats({ slaBreaches: 1 }),
    });
    expect(evaluateIngestAlerts(breached).map((a) => a.code)).toContain(
      "sla_breach",
    );

    const laggy = await collectIngestObservability({
      worker: () => workerStats({ p95LagMs: FETCH_SLA_MS + 1 }),
    });
    const lag = evaluateIngestAlerts(laggy).find((a) => a.code === "fetch_lag");
    expect(lag).toBeDefined();
    expect(lag!.threshold).toBe(FETCH_SLA_MS);
  });

  test("[delta-09] a healthy snapshot raises nothing", async () => {
    const healthy = await collectIngestObservability({
      worker: () => workerStats({ fetched: 10, p95LagMs: 1_000 }),
      content: () => contentStats({ created: 10 }),
      deadLetters: new DeadLetterProbe(new Map([[ADDRESS_A.toLowerCase(), 0]])),
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });
    expect(evaluateIngestAlerts(healthy, healthy)).toEqual([]);
  });
});

describe("W8 — the operator surface (delta 9: DLQ depth visible)", () => {
  test("[delta-09] the reporter emits DLQ depth on the operator stream, with no identifier of any kind", async () => {
    const probe = new DeadLetterProbe(
      new Map([
        [ADDRESS_A.toLowerCase(), 2],
        [ADDRESS_B.toLowerCase(), 1],
      ]),
    );
    const reporter = new IngestObservabilityReporter({
      worker: () => workerStats({ fetched: 4, failed: 1, deadLettered: 3 }),
      content: () => contentStats({ droppedOverflow: 2 }),
      deadLetters: probe,
      cohort: async () =>
        new Set([ADDRESS_A.toLowerCase(), ADDRESS_B.toLowerCase()]),
      sources: [SOURCE],
      nudge: () => ({ nudged: 4, skipped: 0, noWorker: 0, errors: 0 }),
    });

    const capture = captureLogs();
    let emitted: Awaited<ReturnType<IngestObservabilityReporter["emit"]>>;
    try {
      emitted = await reporter.emit();
    } finally {
      capture.restore();
    }

    const line = capture.lines.find((l) => l.includes("op=snapshot"));
    expect(line).toBeDefined();
    expect(line).toContain(OBSERVABILITY_LOG_PREFIX);
    expect(line).toContain("dlq_depth=3");
    expect(line).toContain("deliveries=4");
    expect(line).toContain("fetch_ok=4");
    expect(line).toContain("fetch_fail=4");
    expect(line).toContain("overflow_drops=2");
    expect(emitted.snapshot.dlqDepth).toBe(3);

    const all = capture.lines.join("\n");
    expect(all).not.toContain(ADDRESS_A);
    expect(all).not.toContain(ADDRESS_A.toLowerCase());
    expect(all).not.toContain(ADDRESS_B.toLowerCase());
    expect(all).not.toContain(MEETING_ID);
    expect(all).not.toContain(SECRET_A);
  });

  test("[delta-09] a breached threshold reaches the operator stream as its own alert line", async () => {
    const reporter = new IngestObservabilityReporter({
      worker: () => workerStats({ slaBreaches: 2 }),
      deadLetters: new DeadLetterProbe(
        new Map([[ADDRESS_A.toLowerCase(), DLQ_DEPTH_THRESHOLD + 3]]),
      ),
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });

    const capture = captureLogs();
    try {
      await reporter.emit();
    } finally {
      capture.restore();
    }

    const alerts = capture.lines.filter((l) => l.includes("op=alert"));
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.join("\n")).toContain("code=dlq_depth");
    expect(alerts.join("\n")).toContain("code=sla_breach");
    expect(alerts.join("\n")).not.toContain(ADDRESS_A.toLowerCase());
  });

  test("[delta-09] the reporter compares against its OWN previous snapshot, so growth is visible across emits", async () => {
    const depths = new Map([[ADDRESS_A.toLowerCase(), 0]]);
    const probe = new DeadLetterProbe(depths);
    const reporter = new IngestObservabilityReporter({
      deadLetters: probe,
      cohort: async () => new Set([ADDRESS_A.toLowerCase()]),
      sources: [SOURCE],
    });

    const capture = captureLogs();
    try {
      const first = await reporter.emit();
      expect(first.alerts).toEqual([]);
      depths.set(ADDRESS_A.toLowerCase(), DLQ_GROWTH_THRESHOLD + 1);
      const second = await reporter.emit();
      expect(second.alerts.map((a) => a.code)).toContain("dlq_growth");
    } finally {
      capture.restore();
    }
  });

  test("[delta-09] the reporter's timer never keeps the process alive and stop() is idempotent", () => {
    const reporter = new IngestObservabilityReporter(
      { deadLetters: new DeadLetterProbe(new Map()) },
      { intervalMs: 60_000 },
    );
    reporter.start();
    // A second start must not leave a second timer behind (D4: one reporter per process).
    reporter.start();
    reporter.stop();
    reporter.stop();
    expect(reporter.running).toBe(false);
  });
});

describe("W8 — the operator surface is wired (delta 9: *visible*)", () => {
  test("[delta-09] the reporter is started at startup, inside the dark-flag block", () => {
    const index = readFileSync(
      resolve(import.meta.dir, "../index.ts"),
      "utf8",
    );
    const flagIndex = index.indexOf("if (backendIngestEnabled()) {");
    const reporterIndex = index.indexOf("new IngestObservabilityReporter(");

    // A surface nobody starts is not a surface. It must also be BEHIND the dark gate: a
    // deployment that never enabled backend ingestion runs no reporter and emits no line.
    expect(reporterIndex).toBeGreaterThan(-1);
    expect(flagIndex).toBeGreaterThan(-1);
    expect(reporterIndex).toBeGreaterThan(flagIndex);
    expect(index).toContain("deadLetters: connectorWebhooks.queue");
    expect(index).toContain("cohort: () => connectorWebhooks.modes.cohort()");
    expect(index.slice(reporterIndex, reporterIndex + 600)).toContain(
      ").start()",
    );
  });

  test("[delta-09] exactly ONE process reports: the periodic emit is gated on the D4 lease holder", async () => {
    // An instance that provably refused the seat (`ingest-instance.ts`) ingests nothing, so its
    // periodic line describes a system it is not part of — and during a rolling deploy two
    // instances emit contradicting DLQ/fetch numbers for the same cohort. It also spends a read
    // against the shared single-writer node (`modes.cohort()`) per emit for no reason.
    let holder = false;
    const reporter = new IngestObservabilityReporter(
      { deadLetters: new DeadLetterProbe(new Map()) },
      { intervalMs: 2, enabled: () => holder },
    );

    const capture = captureLogs();
    try {
      reporter.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const whileInert = capture.lines.filter((l) => l.includes("op=snapshot"));
      expect(whileInert).toHaveLength(0);

      holder = true;
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(
        capture.lines.filter((l) => l.includes("op=snapshot")).length,
      ).toBeGreaterThan(0);
    } finally {
      reporter.stop();
      capture.restore();
    }
  });

  test("[delta-09] index.ts gates the reporter on the supervisor's lease, not on the flag alone", () => {
    const index = readFileSync(
      resolve(import.meta.dir, "../index.ts"),
      "utf8",
    );
    expect(index).toMatch(
      /new IngestObservabilityReporter\([\s\S]{0,600}enabled: \(\) => supervisor\.guard\.isHolder\(\)/,
    );
  });
});

describe("W8 — the delivery counter (plan §8.1 W8: deliveries)", () => {
  test("[delta-09] deliveries are counted at the seam and carry no meeting identifier", async () => {
    const onDelivery = createIngestOnDelivery({
      modes: {
        mode: async (address: string): Promise<IngestMode> =>
          address.toLowerCase() === ADDRESS_A.toLowerCase()
            ? "backend"
            : "browser",
      },
      worker: () => ({ nudge: () => {} }),
    });

    await onDelivery({ source: SOURCE, address: ADDRESS_A });
    await onDelivery({ source: SOURCE, address: ADDRESS_A });
    await onDelivery({ source: SOURCE, address: ADDRESS_B });

    const snapshot = await collectIngestObservability({});
    expect(snapshot.deliveries).toBe(3);
    expect(snapshot.nudged).toBe(2);
  });
});

describe("W8 — the credential-op audit (plan §8.1 W8)", () => {
  test("[delta-09] every credential op the store performs increments the audit, and none of them logs the credential", async () => {
    const rows = new InMemoryCredentialRowStore();
    const store = new CredentialStore(rows, {
      master: () => CREDENTIAL_MASTER,
      upstreamRevoker: async () => {},
    });

    const capture = captureLogs();
    try {
      await store.store({
        source: SOURCE,
        address: ADDRESS_A,
        secret: { kind: "oauth", accessToken: SECRET_A } as CredentialSecret,
      });
      await store.rotate({
        source: SOURCE,
        address: ADDRESS_A,
        secret: {
          kind: "oauth",
          accessToken: `${SECRET_A}-rotated`,
        } as CredentialSecret,
      });
      await store.getCredential(SOURCE, ADDRESS_A, "fetch-worker");
      await store.revoke(SOURCE, ADDRESS_A);
    } finally {
      capture.restore();
    }

    const audit = ingestObservabilityCounters().credentials;
    expect(audit.store).toBe(1);
    expect(audit.rotate).toBe(1);
    // TWO reads: the explicit fetch-worker retrieval and the one `revoke` performs internally to
    // call the upstream revoke. Auditing the internal one is the point — a credential leaving the
    // envelope is a credential op no matter who asked.
    expect(audit.read).toBe(2);
    expect(audit.revoke).toBe(1);
    expect(audit.failures).toBe(0);
    expect(audit.total).toBe(5);

    const all = capture.lines.join("\n");
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toContain(ADDRESS_A);
    expect(all).not.toContain(ADDRESS_A.toLowerCase());
    // The address is still THERE — hashed, so an operator can correlate without holding it.
    expect(all).toMatch(/aid=[0-9a-f]{16}/);
  });

  test("[delta-09] a failed credential op is audited as a FAILURE, not as a silent success", async () => {
    const broken: CredentialRowStore = {
      read: async (): Promise<CredentialRow | null> => ({
        source: SOURCE,
        address: ADDRESS_A.toLowerCase(),
        kind: "oauth",
        ciphertext: "not-a-real-envelope",
        wrappedDEK: "not-a-real-wrap",
        createdAt: new Date(T0).toISOString(),
      }),
      write: async () => {},
      remove: async () => {},
    };
    const store = new CredentialStore(broken, { master: () => CREDENTIAL_MASTER });

    const capture = captureLogs();
    try {
      await expect(
        store.getCredential(SOURCE, ADDRESS_A, "fetch-worker"),
      ).rejects.toThrow();
    } finally {
      capture.restore();
    }

    const audit = ingestObservabilityCounters().credentials;
    expect(audit.failures).toBe(1);
    expect(audit.total).toBe(1);
    expect(capture.lines.join("\n")).not.toContain(ADDRESS_A.toLowerCase());
  });
});

describe("W8 — reconcile lag (plan §8.1 W8)", () => {
  test("[delta-09] the reconcile-ack observes lag as a DURATION, never a timestamp beside an id", async () => {
    const clock = { now: T0 };
    const store = new ContentStore(new InMemoryContentBlobStore(), {
      now: () => clock.now,
      master: () => CONTENT_MASTER,
    });

    const upserted = await store.upsert({
      source: SOURCE,
      address: ADDRESS_A,
      sourceId: MEETING_ID,
      kind: "transcript",
      content: { text: TRANSCRIPT_TEXT },
      fetchedAt: new Date(T0).toISOString(),
      receivedAt: new Date(T0).toISOString(),
    });
    expect(upserted.ok).toBe(true);

    clock.now = T0 + 120_000;
    const capture = captureLogs();
    try {
      expect(await store.markReconciled(SOURCE, ADDRESS_A, MEETING_ID)).toBe(true);
    } finally {
      capture.restore();
    }

    const reconcile = ingestObservabilityCounters().reconcile;
    expect(reconcile.observations).toBe(1);
    expect(reconcile.p95LagMs).toBe(120_000);
    expect(reconcile.maxLagMs).toBe(120_000);

    const snapshot = await collectIngestObservability({
      content: () => store.stats(),
    });
    expect(snapshot.reconciled).toBe(1);
    expect(snapshot.reconcileLagP95Ms).toBe(120_000);

    const all = capture.lines.join("\n");
    expect(all).not.toContain(MEETING_ID);
    expect(all).not.toContain(ADDRESS_A.toLowerCase());
    expect(all).not.toContain(TRANSCRIPT_TEXT);
  });

  test("[delta-09] a nonsensical lag is dropped rather than recorded — a metric must not be forgeable", () => {
    recordReconcileLag(-1);
    recordReconcileLag(Number.NaN);
    recordReconcileLag(Number.POSITIVE_INFINITY);
    expect(ingestObservabilityCounters().reconcile.observations).toBe(0);
  });
});

describe("W8 — the shared error redactor (anti-pattern 7)", () => {
  test("[delta-09] an error message carrying a credential or a bare meeting id is redacted by shape, not by provenance", () => {
    const redacted = redactedErrorMessage(
      new Error(
        `kv write failed for ${ADDRESS_A}/${MEETING_ID} using ${SECRET_A}`,
      ),
    );
    expect(redacted).not.toContain(SECRET_A);
    expect(redacted).not.toContain(MEETING_ID);
    expect(redacted).not.toContain(ADDRESS_A);
    expect(redacted).toContain("<address>");
    expect(redacted).toContain("kv write failed");
  });

  test("[delta-09] a refresh token, an API key and a bare provider id are all redacted", () => {
    for (const secretish of [
      "ff-refresh-token-BBBB-2222",
      "sk_live_51NxAbCdEfGhIjKlMnOpQr",
      "01JQZMEETINGIDAAAA0001",
      "8f14e45fceea167a5a36dedd4bea2543",
    ]) {
      expect(redactedErrorMessage(new Error(`upstream said ${secretish}`))).not.toContain(
        secretish,
      );
    }
  });

  test("[delta-09] ordinary triage text still survives — a redactor nobody can read is a redactor nobody keeps", () => {
    for (const message of [
      "connection timeout waiting for node",
      "ECONNREFUSED",
      "rate limited, retry after 60",
    ]) {
      expect(redactedErrorMessage(new Error(message))).toBe(message);
    }
  });
});

describe("W8 — caller-facing errors are generic (anti-pattern 7)", () => {
  test("[delta-09] callerFacingError collapses anything unrecognized to the generic code", () => {
    expect(isCallerSafeError("unavailable")).toBe(true);
    expect(callerFacingError("unavailable")).toBe("unavailable");
    expect(callerFacingError("not_found")).toBe("not_found");
    // The shapes anti-pattern 7 is about: a thrown message, an upstream body, a raw identifier.
    expect(callerFacingError(`ECONNREFUSED reading ${ADDRESS_A}`)).toBe(
      GENERIC_CALLER_ERROR,
    );
    expect(callerFacingError(new Error(SECRET_A))).toBe(GENERIC_CALLER_ERROR);
    expect(callerFacingError(undefined)).toBe(GENERIC_CALLER_ERROR);
    expect(CALLER_SAFE_ERRORS.has(GENERIC_CALLER_ERROR)).toBe(true);
  });

  test("[delta-09] an internal store failure reaches the meetings caller as a generic code, never as its message", async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS_A };
      next();
    });
    const boom = () => {
      throw new Error(
        `kv write failed for ${ADDRESS_A}/${MEETING_ID} using ${SECRET_A}`,
      );
    };
    app.use(
      "/api/connectors/meetings",
      createConnectorMeetingsRouter({
        content: {
          list: async () => boom(),
          get: async () => boom(),
          markReconciled: async () => boom(),
        } as never,
        modes: { mode: async (): Promise<IngestMode> => "backend" },
      }),
    );

    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        for (const [path, method] of [
          ["/api/connectors/meetings", "GET"],
          [`/api/connectors/meetings/${SOURCE}/${MEETING_ID}`, "GET"],
          [
            `/api/connectors/meetings/${SOURCE}/${MEETING_ID}/reconciled`,
            "POST",
          ],
        ] as const) {
          const response = await call(base, path, method);
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.text).not.toContain(SECRET_A);
          expect(response.text).not.toContain(ADDRESS_A);
          expect(response.text).not.toContain("kv write failed");
          expect(isCallerSafeError(response.body?.error)).toBe(true);
        }
      });
    } finally {
      capture.restore();
    }

    const all = capture.lines.join("\n");
    expect(all).not.toContain(SECRET_A);
    expect(all).not.toContain(ADDRESS_A.toLowerCase());
  });

  test("[delta-09] an internal credential failure reaches the caller as a generic code, never as its message", async () => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use((req, _res, next) => {
      req.user = { address: ADDRESS_A };
      next();
    });
    const boom = () => {
      throw new Error(`credential substrate failed for ${ADDRESS_A}: ${SECRET_A}`);
    };
    const oauth: ConnectorOAuthPort = {
      authorizeUrl: () => "https://api.fireflies.ai/authorize",
      exchangeCode: async () => boom(),
      revoke: async () => {},
    };
    app.use(
      "/api/connectors/credentials",
      createConnectorCredentialRouter({
        credentials: {
          store: async () => boom(),
          status: async () => boom(),
          revoke: async () => boom(),
        } as never,
        oauth,
        modes: { mode: async (): Promise<IngestMode> => "backend" },
      }),
    );

    const capture = captureLogs();
    try {
      await withServer(app, async (base) => {
        for (const [path, method] of [
          [`/api/connectors/credentials/${SOURCE}`, "GET"],
          [`/api/connectors/credentials/${SOURCE}`, "DELETE"],
        ] as const) {
          const response = await call(base, path, method);
          expect(response.status).toBeGreaterThanOrEqual(400);
          expect(response.text).not.toContain(SECRET_A);
          expect(response.text).not.toContain(ADDRESS_A);
          expect(response.text).not.toContain("credential substrate failed");
          expect(isCallerSafeError(response.body?.error)).toBe(true);
        }
      });
    } finally {
      capture.restore();
    }

    expect(capture.lines.join("\n")).not.toContain(SECRET_A);
  });
});

async function withServer<T>(
  app: express.Express,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = await new Promise<import("http").Server>((resolve_) => {
    const instance = app.listen(0, () => resolve_(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fn(`http://localhost:${port}`);
  } finally {
    await new Promise<void>((resolve_, reject) =>
      server.close((error) => (error ? reject(error) : resolve_())),
    );
  }
}

async function call(
  base: string,
  path: string,
  method = "GET",
): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(`${base}${path}`, { method });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed as any, text };
}
