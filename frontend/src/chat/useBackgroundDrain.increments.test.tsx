// RED-first contract for the background-drain UX increments (I0 → I3).
//
// The existing `useBackgroundDrain.test.tsx` pins the headless drain's own
// non-negotiables and is deliberately left untouched; this file is purely
// additive and carries the increments' new behaviour. Its fixtures are a
// trimmed copy of that suite's fake companion backend (those are module-private
// there), same idioms: fakes over the typed client, no DOM harness, an
// exploding-unlock tcw, and source assertions for component plumbing.
//
// I0 — the record store. `record` was a module variable nobody could observe.
// It becomes a `useSyncExternalStore`-shaped store:
//
//   * `subscribeBackgroundDrainRecord(cb)` returns an unsubscribe disposer;
//   * `readBackgroundDrainRecord()` stays the snapshot, and is REFERENTIALLY
//     STABLE between real changes (a store that hands back a fresh object on
//     every read makes `useSyncExternalStore` loop forever);
//   * every drain run notifies once at the end, and so does every external
//     publish — so the Settings surface's settled numbers and the headless
//     run's numbers land in the SAME store and a Settings sync can never leave
//     a stale badge behind;
//   * the record stays COUNTS ONLY — never a meeting identifier.
//
// I1 — the pending-count badge on the Settings header button. Two pure helpers
// (`badgePendingCount`, `settingsAriaLabel`) hold the whole policy, so the
// value formula and every hide-state are testable without a DOM:
//
//   * value = Σ pendingCount over ENABLED, "secrets-locked", surface-unblocked
//     entries. `key-missing`, an unblocked leftover, a fail-closed surfacing
//     gate, dark, and failures all render NOTHING — the badge shows counts,
//     never errors, and is silent whenever the meaning is ambiguous;
//   * hidden at count 0, on a null record, when dark, and while the Settings
//     route is open (the section itself is visible there);
//   * the count folds into the EXISTING aria-label in generic copy — never a
//     provider name — and reverts to the exact existing strings when hidden;
//   * it clears reactively through I0: a later settle (headless, unlock-armed,
//     focus-armed, or a Settings publish) recomputes it to 0 with no reload;
//   * sign-out clears the record — and ONLY the record, so the page load's
//     latches survive by design.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  badgePendingCount,
  badgePillLabel,
  clearBackgroundDrainRecord,
  deriveDrainConnectorRecord,
  enqueueDrainWork,
  FOCUS_DEBOUNCE_MS,
  maybeStartBackgroundDrain,
  publishBackgroundDrainConnectorState,
  readBackgroundDrainGeneration,
  readBackgroundDrainRecord,
  removeBackgroundDrainConnectorRecord,
  resetBackgroundDrainForTests,
  resumeBackgroundDrain,
  settingsAriaLabel,
  subscribeBackgroundDrainRecord,
  type BackgroundDrainConnectorRecord,
  type BackgroundDrainHooks,
  type BackgroundDrainOptions,
  type BackgroundDrainRecord,
} from "./useBackgroundDrain";
import {
  onSecretsUnlocked,
  resetSecretsUnlockedListenersForTests,
  unlockSecrets,
} from "@/lib/connectors/connectorSecrets";
import {
  initialBackgroundSyncState,
  type BackgroundSyncState,
} from "./backgroundSyncState";
import { CONNECTORS } from "@/lib/connectors/registry";
import type {
  ConnectorAckResult,
  ConnectorWebhookConfigPoll,
  ConnectorWebhookPending,
  ConnectorWebhooksClient,
  ConnectorWebhooksResult,
} from "@/lib/connectors/webhooksApi";
import type {
  TargetedIngestResult,
  TargetedQueueItem,
} from "@/lib/connectors/targetedSync";
import type {
  ConnectorConnection,
  ConnectorDescriptor,
} from "@/lib/connectors/types";

// ── Fixtures (trimmed from useBackgroundDrain.test.tsx) ──────────────

const BACKEND = "https://backend.example";
const fireflies = CONNECTORS.find((c) => c.id === "fireflies")!;

const SESSION = {
  getToken: () => "session-token",
  isExpired: () => false,
  clear: () => {},
} as unknown as SessionStore;

function item(meetingId: string): TargetedQueueItem {
  return { meetingId, kind: "transcript" };
}

function connection(patch: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    itemCount: 0,
    ...patch,
  };
}

/** The targetedSync idiom: reaching unlock at all fails the run loudly. */
function explodingVaultTcw(unlocked: boolean): TinyCloudWeb {
  return {
    secrets: {
      isUnlocked: unlocked,
      unlock: () => {
        throw new Error("the headless drain must never trigger an unlock prompt");
      },
    },
  } as unknown as TinyCloudWeb;
}

interface FakeBackend {
  webhooks: ConnectorWebhooksClient;
  events: string[];
  queue: () => TargetedQueueItem[];
}

function backend(
  opts: {
    pending?: TargetedQueueItem[];
    enabled?: boolean;
    config?: ConnectorWebhooksResult<ConnectorWebhookConfigPoll>;
  } = {},
): FakeBackend {
  let queue: TargetedQueueItem[] = [...(opts.pending ?? [])];
  const events: string[] = [];
  const enabled = opts.enabled ?? true;

  const pendingValue = (): ConnectorWebhookPending => ({
    enabled,
    disabledAt: null,
    source: "fireflies",
    deliveriesRateLimited: false,
    count: queue.length,
    pending: queue.map((q) => ({
      meetingId: q.meetingId,
      kind: q.kind,
      receivedAt: "2026-08-07T09:00:00.000Z",
      attempts: 0,
      nextAttemptAt: "2026-08-07T09:00:00.000Z",
    })),
    deadCount: 0,
    dead: [],
  });

  const never = (name: string) => async () => {
    throw new Error(`the headless drain must never call ${name}`);
  };

  const webhooks: ConnectorWebhooksClient = {
    getConfig: async () => {
      events.push("config");
      if (opts.config) return opts.config;
      return {
        status: "ok",
        value: {
          enabled,
          disabledAt: null,
          source: "fireflies",
          url: null,
          secret: null,
          hasSecret: enabled,
          createdAt: enabled ? "2026-08-06T10:00:00.000Z" : null,
        },
      };
    },
    getPending: async () => {
      events.push("pending");
      return { status: "ok", value: pendingValue() };
    },
    drain: async () => {
      events.push("drain:start");
      events.push("drain:end");
      return { status: "ok", value: pendingValue() };
    },
    acknowledge: async (request) => {
      events.push(`ack:${request.items.map((i) => i.meetingId).join(",")}`);
      const before = queue.length;
      queue = queue.filter(
        (q) =>
          !request.items.some(
            (i) => i.meetingId === q.meetingId && i.kind === q.kind,
          ),
      );
      const acknowledged = before - queue.length;
      const value: ConnectorAckResult = {
        ...pendingValue(),
        status: "acknowledged",
        acknowledged,
        alreadySettled: request.items.length - acknowledged,
        tombstoned: 0,
      };
      return { status: "ok", value };
    },
    enable: never("enable"),
    disable: never("disable"),
    recordPurge: never("recordPurge"),
    clearPurgeLedger: never("clearPurgeLedger"),
  };

  return { webhooks, events, queue: () => queue };
}

const neverIngest = async (): Promise<TargetedIngestResult> => {
  throw new Error("ingest must not run in this scenario");
};

interface StartOverrides {
  tcw?: TinyCloudWeb | null;
  connection?: ConnectorConnection | null;
  connectors?: readonly ConnectorDescriptor[];
  ingest?: (
    descriptor: ConnectorDescriptor,
    items: readonly TargetedQueueItem[],
  ) => Promise<TargetedIngestResult>;
  /** I3's clock seam: the pacing window is compared, never waited on, so a
   *  test crosses 45 minutes by returning a bigger number — never by advancing
   *  a real clock and never by a timer (there are none). */
  now?: () => number;
}

function drainOptions(
  b: FakeBackend,
  over: StartOverrides = {},
): BackgroundDrainOptions {
  const getConnection: NonNullable<BackgroundDrainHooks["getConnection"]> =
    async () => ({
      ok: true,
      data: over.connection === undefined ? connection() : over.connection,
    });
  return {
    tcw: over.tcw === undefined ? explodingVaultTcw(true) : over.tcw,
    sessionStore: SESSION,
    backendUrl: BACKEND,
    hooks: {
      webhooks: b.webhooks,
      getConnection,
      connectors: over.connectors ?? [fireflies],
      ingest: over.ingest ?? (() => neverIngest()),
      now: over.now,
    },
  };
}

function start(b: FakeBackend, over: StartOverrides = {}) {
  return maybeStartBackgroundDrain(drainOptions(b, over));
}

/** The suite's ingest fake: one sequential pass, then the backend ack that
 *  actually settles the fake queue. */
function recordingIngest(b: FakeBackend) {
  const calls: TargetedQueueItem[][] = [];
  const run = async (
    items: readonly TargetedQueueItem[],
  ): Promise<TargetedIngestResult> => {
    calls.push([...items]);
    b.events.push("ingest:start");
    for (const it of items) {
      // Sequential by construction — never a per-meeting fan-out.
      await Promise.resolve();
      void it;
    }
    const ack = await b.webhooks.acknowledge({
      source: "fireflies",
      items: items.map((i) => ({
        meetingId: i.meetingId,
        kind: i.kind,
        status: "done" as const,
      })),
    });
    b.events.push("ingest:end");
    return {
      ok: true,
      data: {
        stored: items.length,
        inserted: items.length,
        updated: 0,
        acknowledged: ack.status === "ok" ? ack.value.acknowledged : 0,
        alreadySettled: ack.status === "ok" ? ack.value.alreadySettled : 0,
        tombstoned: 0,
        failures: [],
        unacknowledged: [],
        ackError: ack.status === "ok" ? null : ack.status,
        blocked: null,
        itemCount: items.length,
      },
    };
  };
  return { run, calls };
}

/** A settled Settings-surface state: the numbers the section already holds
 *  after `loadOnMount` / `syncQueuedMeetings` / a retry — no HTTP re-count. */
function settingsState(patch: Partial<BackgroundSyncState> = {}): BackgroundSyncState {
  return {
    ...initialBackgroundSyncState(),
    phase: "enabled",
    hasSecret: true,
    queue: { pendingCount: 0, deadCount: 0, rateLimited: false, blockedReason: null },
    ...patch,
  };
}

/** Counts notifications and remembers the snapshot at each one. */
function listen() {
  const seen: (ReturnType<typeof readBackgroundDrainRecord>)[] = [];
  const unsubscribe = subscribeBackgroundDrainRecord(() => {
    seen.push(readBackgroundDrainRecord());
  });
  return { seen, unsubscribe, count: () => seen.length };
}

beforeEach(() => {
  resetBackgroundDrainForTests();
});

// ── I0: the record store ─────────────────────────────────────────────

describe("I0 record store — subscription seam", () => {
  test("a finished headless run notifies subscribers once and swaps the snapshot reference", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const before = readBackgroundDrainRecord();
    expect(before).toBeNull();
    const sub = listen();

    await start(b, { tcw: explodingVaultTcw(false) });

    // ONE batch commit at the end of the run — not one per connector, not one
    // per emitted state.
    expect(sub.count()).toBe(1);
    const after = readBackgroundDrainRecord();
    expect(after).not.toBe(before);
    expect(after?.connectors[0]?.pendingCount).toBe(2);
    // The snapshot is referentially stable between changes: two reads with no
    // commit in between MUST be the same object, or useSyncExternalStore loops.
    expect(readBackgroundDrainRecord()).toBe(after);
    sub.unsubscribe();
  });

  test("the unsubscribe disposer stops notifications", async () => {
    const sub = listen();
    publishBackgroundDrainConnectorState(
      "fireflies",
      settingsState({ queue: { pendingCount: 3, deadCount: 0, rateLimited: false, blockedReason: null } }),
      true,
    );
    expect(sub.count()).toBe(1);

    sub.unsubscribe();
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    // The store still changed…
    expect(readBackgroundDrainRecord()?.connectors[0]?.pendingCount).toBe(0);
    // …but this listener is gone.
    expect(sub.count()).toBe(1);
  });

  test("a throwing subscriber neither breaks the commit nor starves the others", async () => {
    const calls: string[] = [];
    const stopA = subscribeBackgroundDrainRecord(() => {
      calls.push("a");
      throw new Error("a listener blew up");
    });
    const stopB = subscribeBackgroundDrainRecord(() => {
      calls.push("b");
    });
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    expect(calls).toEqual(["a", "b"]);
    expect(readBackgroundDrainRecord()?.connectors).toHaveLength(1);
    stopA();
    stopB();
  });
});

describe("I0 record store — publish from the Settings path", () => {
  test("publishing the Settings surface's settled state upserts by source with ZERO backend calls", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(readBackgroundDrainRecord()?.connectors[0]?.pendingCount).toBe(2);
    const eventsAfterDrain = [...b.events];

    const sub = listen();
    // The Settings sync just settled the queue; it publishes the numbers it
    // ALREADY holds — no re-count, no HTTP.
    publishBackgroundDrainConnectorState(fireflies.source, settingsState(), false);

    expect(sub.count()).toBe(1);
    const after = readBackgroundDrainRecord();
    // Upsert by source: one entry, not two.
    expect(after?.connectors).toHaveLength(1);
    expect(after?.connectors[0]?.source).toBe(fireflies.source);
    expect(after?.connectors[0]?.pendingCount).toBe(0);
    // The publish path spoke to nobody.
    expect(b.events).toEqual(eventsAfterDrain);
    sub.unsubscribe();
  });

  test("a second source is added rather than replacing the first", () => {
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    publishBackgroundDrainConnectorState(
      "fireflies-two",
      settingsState({ queue: { pendingCount: 5, deadCount: 0, rateLimited: false, blockedReason: null } }),
      true,
    );
    const record = readBackgroundDrainRecord();
    expect(record?.connectors.map((c) => c.source)).toEqual([
      "fireflies",
      "fireflies-two",
    ]);
  });

  test("a loading-phase state is never published", () => {
    const sub = listen();
    publishBackgroundDrainConnectorState(
      "fireflies",
      initialBackgroundSyncState(), // phase: "loading" — "we have not asked yet"
      true,
    );
    // A freshly mounting section must not clobber a real headless record with
    // nulls, nor invent a record where there was none.
    expect(sub.count()).toBe(0);
    expect(readBackgroundDrainRecord()).toBeNull();
    sub.unsubscribe();
  });

  test("a value-equal republish neither notifies nor swaps the reference", () => {
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    const first = readBackgroundDrainRecord();
    const sub = listen();

    // A fresh but value-identical state object (the section emits several of
    // these as busy flags flip) must not wake the badge up.
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    expect(sub.count()).toBe(0);
    expect(readBackgroundDrainRecord()).toBe(first);

    // A real change still does.
    publishBackgroundDrainConnectorState(
      "fireflies",
      settingsState({ queue: { pendingCount: 4, deadCount: 0, rateLimited: false, blockedReason: null } }),
      true,
    );
    expect(sub.count()).toBe(1);
    expect(readBackgroundDrainRecord()).not.toBe(first);
    sub.unsubscribe();
  });
});

describe("I0 record store — honest blocked reason", () => {
  test("a locked count-only run publishes ingestBlocked \"secrets-locked\"", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    // The decision layer only sets `ingestBlocked` after an ingest actually
    // ran, so a locked count-only pass would otherwise record `null` — the
    // exact scenario the badge exists for. The publisher derives it from the
    // vault state it already read.
    const entry = readBackgroundDrainRecord()?.connectors[0];
    expect(entry?.phase).toBe("enabled");
    expect(entry?.pendingCount).toBe(2);
    expect(entry?.ingestBlocked).toBe("secrets-locked");
    expect(entry?.surfaceBlocked).toBe(false);
  });

  test("the derivation is honest: unlocked, empty, and already-blocked cases", () => {
    const locked = { pendingCount: 2, deadCount: 0, rateLimited: false, blockedReason: null };
    // Locked + waiting → blocked on the vault.
    expect(
      deriveDrainConnectorRecord("fireflies", settingsState({ queue: locked }), true)
        .ingestBlocked,
    ).toBe("secrets-locked");
    // Unlocked + waiting → nothing is blocking; a later run will process it.
    expect(
      deriveDrainConnectorRecord("fireflies", settingsState({ queue: locked }), false)
        .ingestBlocked,
    ).toBeNull();
    // Locked + nothing waiting → no claim at all.
    expect(
      deriveDrainConnectorRecord("fireflies", settingsState(), true).ingestBlocked,
    ).toBeNull();
    // An explicit reason from the decision layer always wins.
    expect(
      deriveDrainConnectorRecord(
        "fireflies",
        settingsState({ queue: locked, ingestBlocked: "key-missing" }),
        true,
      ).ingestBlocked,
    ).toBe("key-missing");
    // The fail-closed surfacing gate travels as a boolean, never a reason string.
    expect(
      deriveDrainConnectorRecord(
        "fireflies",
        settingsState({
          queue: { ...locked, blockedReason: "unknown" },
        }),
        true,
      ).surfaceBlocked,
    ).toBe(true);
  });
});

describe("I0 record store — counts only", () => {
  test("the published record serializes without meeting identifiers", async () => {
    const b = backend({ pending: [item("meeting-alpha"), item("meeting-beta")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    publishBackgroundDrainConnectorState(fireflies.source, settingsState(), false);
    const serialized = JSON.stringify(readBackgroundDrainRecord());
    expect(serialized).not.toContain("meeting-alpha");
    expect(serialized).not.toContain("meeting-beta");
    expect(serialized).not.toContain("transcript");
  });
});

describe("I0 record store — wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("the Settings section publishes its own post-run state into the same store", () => {
    const section = read("BackgroundSyncSection.tsx");
    expect(section).toContain("publishBackgroundDrainConnectorState");
    // Publish rides the section's ONE emit callback — the numbers are already
    // in hand after every run. No new client call, no new HTTP re-count.
    expect(section).not.toMatch(/getPending\s*\(/);
    // The lane-entry literals are untouched (no second drain lane).
    expect(section).toContain("enqueueDrainWork(() => loadOnMount(deps, emit))");
    expect(section).toContain("enqueueDrainWork(() => syncQueuedMeetings(deps, emit))");
  });

  test("the store resets cleanly for tests: record, listeners and all", async () => {
    const sub = listen();
    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    expect(sub.count()).toBe(1);

    resetBackgroundDrainForTests();
    expect(readBackgroundDrainRecord()).toBeNull();

    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    // The subscriber from the previous "session" is gone with the reset.
    expect(sub.count()).toBe(1);
  });
});

// ── I1: the pending-count badge ──────────────────────────────────────

function entry(
  patch: Partial<BackgroundDrainConnectorRecord> = {},
): BackgroundDrainConnectorRecord {
  return {
    source: "fireflies",
    phase: "enabled",
    pendingCount: 3,
    ingestBlocked: "secrets-locked",
    surfaceBlocked: false,
    lastIngest: null,
    ...patch,
  };
}

function rec(
  connectors: BackgroundDrainConnectorRecord[],
  featureDark = false,
): BackgroundDrainRecord {
  return { featureDark, connectors };
}

describe("I1 badge — the value formula", () => {
  test("sums pendingCount across enabled + secrets-locked + surface-unblocked entries", () => {
    expect(
      badgePendingCount(
        rec([
          entry({ source: "a", pendingCount: 3 }),
          entry({ source: "b", pendingCount: 4 }),
        ]),
      ),
    ).toBe(7);
  });

  test("everything ambiguous contributes ZERO — the badge shows counts, never errors", () => {
    // "key-missing" is on the handoff's render-nothing list: Settings owns that
    // detail, and no count of it belongs in the header.
    expect(badgePendingCount(rec([entry({ ingestBlocked: "key-missing" })]))).toBe(0);
    // Unblocked-but-unprocessed: an attempt RAN and items stayed queued, i.e. a
    // failure. Silent-on-ambiguity — badging it would surface failures outside
    // Settings.
    expect(badgePendingCount(rec([entry({ ingestBlocked: null })]))).toBe(0);
    // The Settings surface's own fail-closed gate refuses to vouch for the
    // count; the badge fails closed with it.
    expect(badgePendingCount(rec([entry({ surfaceBlocked: true })]))).toBe(0);
    // Not enabled → there is no queue to speak for. ("off" and "unavailable"
    // are real BackgroundSyncPhase values — the pin must match reality.)
    expect(badgePendingCount(rec([entry({ phase: "off" })]))).toBe(0);
    expect(badgePendingCount(rec([entry({ phase: "unavailable" })]))).toBe(0);
    // The catch-path "we don't know" entry.
    expect(badgePendingCount(rec([entry({ pendingCount: null })]))).toBe(0);
    // A negative/absurd count never becomes a negative badge.
    expect(badgePendingCount(rec([entry({ pendingCount: -2 })]))).toBe(0);
    // One good entry alongside the noise still counts, and only itself.
    expect(
      badgePendingCount(
        rec([
          entry({ source: "a", pendingCount: 2 }),
          entry({ source: "b", pendingCount: 9, ingestBlocked: "key-missing" }),
          entry({ source: "c", pendingCount: 9, surfaceBlocked: true }),
        ]),
      ),
    ).toBe(2);
  });
});

describe("I1 badge — hide states", () => {
  test("count 0, a null record, dark, and a dark entry all render nothing", () => {
    // Nothing waiting.
    expect(badgePendingCount(rec([entry({ pendingCount: 0 })]))).toBe(0);
    expect(badgePendingCount(rec([]))).toBe(0);
    // Pre-first-run, and post-sign-out.
    expect(badgePendingCount(null)).toBe(0);
    // Feature dark — the default deployment today. A dark page load must be
    // silent in the header as well as everywhere else.
    expect(badgePendingCount(rec([entry()], true))).toBe(0);
    expect(badgePendingCount(rec([entry({ phase: "dark" })]))).toBe(0);
  });

  test("identity mismatch: the record is cleared on sign-out, and ONLY the record", async () => {
    const b = backend({ pending: [item("m1"), item("m2"), item("m3")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(3);

    const sub = listen();
    clearBackgroundDrainRecord();
    // User B on user A's page load never inherits A's counts.
    expect(sub.count()).toBe(1);
    expect(readBackgroundDrainRecord()).toBeNull();
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
    // A second clear is a no-op, not a spurious notification.
    clearBackgroundDrainRecord();
    expect(sub.count()).toBe(1);

    // Deliberately ONLY the record: this page load's attempt latch survives, so
    // a sign-out/sign-in inside one page load does not re-arm the mount path.
    const b2 = backend({ pending: [item("m9")] });
    await start(b2, { tcw: explodingVaultTcw(false) });
    expect(b2.events).toEqual([]);
    expect(readBackgroundDrainRecord()).toBeNull();
    sub.unsubscribe();
  });
});

describe("I1 badge — accessibility copy", () => {
  test("the count folds into the EXISTING aria-label, generically", () => {
    expect(settingsAriaLabel(false, 3)).toBe("Settings — 3 meetings waiting");
    expect(settingsAriaLabel(false, 1)).toBe("Settings — 1 meeting waiting");
  });

  test("when hidden the label reverts to the existing strings EXACTLY", () => {
    expect(settingsAriaLabel(false, 0)).toBe("Settings");
    // On the settings route the section itself is visible; the button is a
    // close affordance and says only that.
    expect(settingsAriaLabel(true, 0)).toBe("Close settings");
    expect(settingsAriaLabel(true, 5)).toBe("Close settings");
  });

  test("no provider name ever reaches the label", () => {
    for (const label of [
      settingsAriaLabel(false, 0),
      settingsAriaLabel(false, 1),
      settingsAriaLabel(false, 42),
      settingsAriaLabel(true, 42),
    ]) {
      expect(label.toLowerCase()).not.toContain("fireflies");
      for (const descriptor of CONNECTORS) {
        expect(label.toLowerCase()).not.toContain(descriptor.source.toLowerCase());
        expect(label.toLowerCase()).not.toContain(descriptor.name.toLowerCase());
      }
    }
  });
});

describe("I1 badge — reactive clearing", () => {
  test("a Settings publish clears the badge with NO reload", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The badge's subscriber sees the settle the moment it happens.
    const sub = listen();
    publishBackgroundDrainConnectorState(fireflies.source, settingsState(), false);
    expect(sub.count()).toBe(1);
    expect(badgePendingCount(sub.seen[0] ?? null)).toBe(0);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
    sub.unsubscribe();
  });

  test("a headless re-count of a still-locked queue moves the badge to the new number", async () => {
    const b = backend({ pending: [item("m1")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(1);

    const sub = listen();
    publishBackgroundDrainConnectorState(
      fireflies.source,
      settingsState({
        queue: { pendingCount: 4, deadCount: 0, rateLimited: false, blockedReason: null },
      }),
      true,
    );
    expect(sub.count()).toBe(1);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(4);
    sub.unsubscribe();
  });
});

describe("I1 badge — App wiring (source-asserted)", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("App follows the store with useSyncExternalStore over I0's seam", () => {
    const app = read("../App.tsx");
    expect(app).toContain("useSyncExternalStore");
    expect(app).toContain("subscribeBackgroundDrainRecord");
    expect(app).toContain("readBackgroundDrainRecord");
    // No polling, no second count, no badge-owned state.
    expect(app).not.toContain("setInterval");
    // The count is the shared helper's, suppressed on the settings route.
    expect(app).toMatch(/showSettings\s*\?\s*0\s*:\s*badgePendingCount\(/);
  });

  test("the pill lives INSIDE the existing button, aria-hidden and layout-neutral", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("aria-label={settingsAriaLabel(showSettings");
    expect(at).toBeGreaterThan(0);
    const button = app.slice(at, app.indexOf("</Button>", at));
    // Absolutely positioned inside the button's own relative box, so the
    // 44/32px footprint never changes — no layout shift.
    expect(button).toContain("relative");
    expect(button).toContain("absolute");
    expect(button).toContain('aria-hidden="true"');
    // The existing icon is still the button's content.
    expect(button).toContain("<SettingsIcon");
    // The aria-label is the single announcement; the pill itself renders the
    // bare count and no copy at all — so no provider name, and nothing for a
    // screen reader to double-announce.
    expect(button.toLowerCase()).not.toContain("fireflies");
    const pill = button.slice(button.indexOf("<span"), button.indexOf("</span>"));
    const children = pill.slice(pill.lastIndexOf(">") + 1).trim();
    expect(children).toBe("{badgePillLabel(pendingMeetings)}");
  });

  test("the drainer mount gate is untouched by the badge edit", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("<BackgroundDrainer");
    expect(at).toBeGreaterThan(0);
    expect(app.slice(at - 200, at)).toContain('state === "ready" && tcw &&');
  });

  test("signOut clears the drain record beside the other account-scoped caches", () => {
    const app = read("../App.tsx");
    const from = app.indexOf("const signOut = useCallback");
    expect(from).toBeGreaterThan(0);
    const body = app.slice(from, app.indexOf("const isReady", from));
    expect(body).toContain("historyPrefetch.clear();");
    expect(body).toContain("clearAgentSessionCache();");
    expect(body).toContain("clearBackgroundDrainRecord();");
    // The page load's latches are NOT reset here — only the record is.
    expect(body).not.toContain("resetBackgroundDrainForTests");
  });
});

describe("I1 badge — the pill clamps its display, the label does not", () => {
  test("counts above 99 render as \"99+\" in the pill only", () => {
    expect(badgePillLabel(1)).toBe("1");
    expect(badgePillLabel(99)).toBe("99");
    expect(badgePillLabel(100)).toBe("99+");
    expect(badgePillLabel(1234)).toBe("99+");
    // The pill is aria-hidden; the LABEL is the announcement and it keeps the
    // exact number — the clamp is a visual overflow rule, never a rounding of
    // what the user is told.
    expect(settingsAriaLabel(false, 100)).toBe("Settings — 100 meetings waiting");
    expect(settingsAriaLabel(false, 1234)).toBe("Settings — 1234 meetings waiting");
  });

  test("App renders the clamped pill text and the unclamped label (source-asserted)", () => {
    const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(app).toContain("badgePillLabel(pendingMeetings)");
    // The label call still takes the raw count — no clamp on its way in.
    expect(app).toContain("settingsAriaLabel(showSettings, pendingMeetings)");
  });
});

// ── I2: drain-on-unlock re-arm ───────────────────────────────────────
//
// The mount drain almost always runs against a LOCKED vault — unlock state is
// not persisted, so a boot-time session restore leaves the vault shut until
// something calls `unlock()`, and the headless path is rightly forbidden from
// doing that. So the mount pass counts and ingests nothing, and today nothing
// ever revisits it. I2 closes that loop from the other side: when the user
// unlocks the vault for ANY reason, the drain re-arms.
//
// The rules this section pins:
//
//   * the seam is `onSecretsUnlocked` — the lib-side registry fed by the ONE
//     `unlockSecrets` choke point, so all four production unlock sites are
//     covered and nothing else is;
//   * the re-arm bypasses pacing (an unlock is the strong signal the counted
//     backlog just became ingestable) but still enters through
//     `enqueueDrainWork`, so it serializes behind whatever flow unlocked;
//   * DIRECTION IS ONE-WAY: unlock → drain, never drain → unlock. A re-armed
//     run whose vault is locked again only counts, exactly like a mount;
//   * signed out, dark, and unmounted are all free no-ops.

function unlockableTcw(): TinyCloudWeb {
  return {
    secrets: {
      isUnlocked: false,
      unlock: async () => ({ ok: true, data: undefined }),
    },
  } as unknown as TinyCloudWeb;
}

/** Register the re-arm exactly as the hook's effect does, drive a real
 *  user-initiated unlock through the choke point, and hand back the promise
 *  the listener started so the test can await the lane. */
async function unlockAndAwaitRearm(options: BackgroundDrainOptions): Promise<void> {
  const armed: Promise<void>[] = [];
  const off = onSecretsUnlocked(() => {
    armed.push(resumeBackgroundDrain(options, "unlock"));
  });
  const res = await unlockSecrets<{ code?: string; message?: string }>(unlockableTcw());
  off();
  expect(res.ok).toBe(true);
  expect(armed).toHaveLength(1);
  await armed[0];
}

describe("I2 unlock re-arm — the re-armed run", () => {
  beforeEach(() => {
    resetSecretsUnlockedListenersForTests();
  });

  test("a user unlock drains the counted backlog through the shared lane", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });

    // Mount, locked: the queue is counted and nothing is ingested. This is the
    // state almost every page load is really in.
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(b.events).toEqual(["config", "pending"]);
    expect(b.queue()).toHaveLength(2);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The user unlocks from one of the four sites. Same options the mount used,
    // with the vault now open.
    const rec = recordingIngest(b);
    await unlockAndAwaitRearm(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        ingest: (_d, items) => rec.run(items),
      }),
    );

    // ONE ingest call carrying the whole surfaced queue, in order.
    expect(rec.calls).toEqual([[item("m1"), item("m2")]]);
    expect(b.queue()).toHaveLength(0);
    // And the badge settles with it — no reload.
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
    expect(readBackgroundDrainRecord()?.connectors[0]?.pendingCount).toBe(0);
  });

  test("the re-arm bypasses pacing — a just-finished mount attempt does not block it", async () => {
    const b = backend({ pending: [item("m1")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    const afterMount = [...b.events];

    // The mount latch (and, once I3 lands, the freshly burned attempt
    // timestamp) would swallow any paced trigger arriving this soon. An unlock
    // is not paced: it is the signal that the counted backlog became
    // ingestable, so it runs immediately.
    const rec = recordingIngest(b);
    await unlockAndAwaitRearm(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        ingest: (_d, items) => rec.run(items),
      }),
    );

    expect(b.events.length).toBeGreaterThan(afterMount.length);
    expect(rec.calls).toHaveLength(1);
    expect(b.queue()).toHaveLength(0);
  });

  test("a re-arm enqueued mid-flight serializes behind the work already on the lane", async () => {
    const b = backend({ pending: [item("m1")] });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Stand in for the flow that triggered the unlock (a Settings sync, a card
    // "Sync now") — it is already on the lane when the notify fires.
    const holding = enqueueDrainWork(async () => {
      b.events.push("holder:start");
      await held;
      b.events.push("holder:end");
    });

    const rec = recordingIngest(b);
    const armed = resumeBackgroundDrain(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        ingest: (_d, items) => rec.run(items),
      }),
      "unlock",
    );

    // Let every microtask that could jump the queue run.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(b.events).toEqual(["holder:start"]);

    release();
    await holding;
    await armed;

    expect(b.events[0]).toBe("holder:start");
    expect(b.events[1]).toBe("holder:end");
    // The re-armed run started only after the holder finished.
    expect(b.events[2]).toBe("config");
    expect(b.queue()).toHaveLength(0);
  });

  test("a re-armed run whose vault is locked again only COUNTS — it never unlocks", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(b.queue()).toHaveLength(2);

    // The vault relocked between the notify and the run (or the unlock was for
    // a different space). The re-armed run is a headless run like any other:
    // reaching `unlock` at all throws in this fixture.
    await unlockAndAwaitRearm(drainOptions(b, { tcw: explodingVaultTcw(false) }));

    expect(b.events).toEqual(["config", "pending", "config", "pending"]);
    expect(b.queue()).toHaveLength(2);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);
  });
});

describe("I2 unlock re-arm — the free no-ops", () => {
  beforeEach(() => {
    resetSecretsUnlockedListenersForTests();
  });

  test("signed out: a re-arm with no tcw touches nothing", async () => {
    const b = backend({ pending: [item("m1")] });
    await resumeBackgroundDrain(drainOptions(b, { tcw: null }), "unlock");
    expect(b.events).toEqual([]);
    expect(readBackgroundDrainRecord()).toBeNull();

    // And the page load's mount attempt is still available afterwards.
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(b.events).toEqual(["config", "pending"]);
  });

  test("dark stays latched across re-arms: one probe per page load, never one per unlock", async () => {
    const b = backend({ config: { status: "feature-dark" } });
    await start(b);
    expect(b.events).toEqual(["config"]);
    expect(readBackgroundDrainRecord()?.featureDark).toBe(true);

    await unlockAndAwaitRearm(drainOptions(b, { tcw: explodingVaultTcw(true) }));
    await unlockAndAwaitRearm(drainOptions(b, { tcw: explodingVaultTcw(true) }));

    // Still exactly one probe. A dark deployment is every user's path today.
    expect(b.events).toEqual(["config"]);
  });

  test("after the disposer runs — the unmounted app shell — an unlock re-arms nothing", async () => {
    const b = backend({ pending: [item("m1")] });
    const armed: Promise<void>[] = [];
    const off = onSecretsUnlocked(() => {
      armed.push(resumeBackgroundDrain(drainOptions(b), "unlock"));
    });
    off();

    const res = await unlockSecrets<{ code?: string; message?: string }>(unlockableTcw());
    expect(res.ok).toBe(true);
    expect(armed).toHaveLength(0);
    expect(b.events).toEqual([]);
  });

  test("a re-arm never rejects, even when the client throws", async () => {
    const b = backend({ pending: [item("m1")] });
    const exploding = {
      ...b.webhooks,
      getConfig: async () => {
        throw new Error("network is down");
      },
    };
    const options = drainOptions(b, { tcw: explodingVaultTcw(true) });
    const resolved = await resumeBackgroundDrain(
      { ...options, hooks: { ...options.hooks, webhooks: exploding } },
      "unlock",
    ).then(
      () => "resolved",
      () => "rejected",
    );
    expect(resolved).toBe("resolved");
    // Quiet by contract: the failure is recorded as "we don't know", nothing
    // is surfaced, and the lane is not poisoned.
    expect(readBackgroundDrainRecord()?.connectors[0]?.phase).toBe("unavailable");
    const after = backend({ pending: [item("m2")] });
    await resumeBackgroundDrain(drainOptions(after, { tcw: explodingVaultTcw(false) }), "unlock");
    expect(after.events).toEqual(["config", "pending"]);
  });
});

describe("I2 unlock re-arm — wiring and direction (source-asserted)", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("the hook's mount effect registers the re-arm and unregisters on cleanup", () => {
    const drain = read("useBackgroundDrain.ts");
    expect(drain).toContain("onSecretsUnlocked");
    expect(drain).toContain("resumeBackgroundDrain");
    // Registration is effect-time, inside the hook — never a module-load side
    // effect (that would leak across test files and outlive sign-out).
    const at = drain.indexOf("export function useBackgroundDrain");
    expect(at).toBeGreaterThan(0);
    const hook = drain.slice(at);
    expect(hook).toContain("onSecretsUnlocked");
    // Symmetric cleanup: the effect returns its own disposer.
    expect(hook).toMatch(/return\s*\(\)\s*=>/);
    // No timers, ever.
    expect(drain).not.toContain("setInterval");
    expect(drain).not.toContain("setTimeout");
  });

  test("direction is one-way: the re-arm path cannot reach an unlock", () => {
    // The drain module still does not even import the interactive helper — the
    // registry is an OUTPUT of `unlockSecrets`, never an input to it.
    expect(read("useBackgroundDrain.ts")).not.toContain("unlockSecrets");
    // And the headless deps' hard-wired refusal is untouched.
    expect(read("useBackgroundDrain.ts")).toContain("The headless drain never unlocks.");
  });

  test("the registry keeps lib/ free of any chat/ import", () => {
    const secrets = read("../lib/connectors/connectorSecrets.ts");
    expect(secrets).toContain("onSecretsUnlocked");
    expect(secrets).not.toContain("@/chat");
    expect(secrets).not.toContain("useBackgroundDrain");
    expect(secrets).not.toContain("../../chat");
  });
});

// ── I3: the focus-gated re-check ─────────────────────────────────────
//
// I2 covers the user who unlocks. I3 covers the OTHER long-lived case: a chat
// tab left open all day, where the mount attempt happened hours ago and nothing
// ever revisits the queue. The "once per session" boolean becomes a
// `lastAttemptStartedAt` timestamp so a returning user's focus can be gated on
// elapsed time instead of on a latch that never reopens.
//
// The rules this section pins:
//
//   * PACING, NOT POLLING. There are no timers anywhere — the window is a
//     COMPARISON made when a focus event arrives. Two ticks inside one window
//     produce ONE attempt; the first tick past it attempts;
//   * MOUNT IS UNCHANGED. Its latch stays `!== 0` — permanent, never
//     time-based — so a remount/re-render still never re-runs the mount path;
//   * THE TIMESTAMP BURNS ONLY ON A REAL ATTEMPT. A signed-out tick and a
//     dark-latched tick attempt nothing, so they burn nothing;
//   * DARK SURVIVES EVERY RE-ARM. A route-disabled deployment — every user's
//     path today — pays ONE probe per page load, never one per focus;
//   * an unlock re-arm bypasses the window (I2) but still records its attempt,
//     which pushes the next eligible tick out by a full window;
//   * a focus attempt is a headless run like any other: same lane, same one
//     pass, no unlock, quiet on failure.

const T0 = Date.parse("2026-08-07T09:00:00.000Z");
const MINUTE = 60_000;

/** A hand-cranked clock. Time only ever moves because a test says so. */
function clock(at = T0) {
  let value = at;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
  };
}

describe("I3 focus re-check — the debounce window", () => {
  test("FOCUS_DEBOUNCE_MS is one exported named constant inside [30, 60] minutes", () => {
    expect(typeof FOCUS_DEBOUNCE_MS).toBe("number");
    expect(FOCUS_DEBOUNCE_MS).toBeGreaterThanOrEqual(30 * MINUTE);
    expect(FOCUS_DEBOUNCE_MS).toBeLessThanOrEqual(60 * MINUTE);
  });

  test("two focus ticks inside ONE window produce exactly one attempt", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    const options = drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now });

    // Nothing has attempted yet (timestamp 0 = never), so the first tick is
    // trivially eligible.
    await resumeBackgroundDrain(options, "focus");
    expect(b.events).toEqual(["config", "pending"]);

    // A user who alt-tabs back and forth all morning is not a reason to drain
    // again: still inside the window, so the tick is free.
    c.set(T0 + MINUTE);
    await resumeBackgroundDrain(options, "focus");
    c.set(T0 + FOCUS_DEBOUNCE_MS - MINUTE);
    await resumeBackgroundDrain(options, "focus");
    expect(b.events).toEqual(["config", "pending"]);
  });

  test("the first tick PAST the window attempts, and re-arms the window behind it", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    const options = drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now });

    await resumeBackgroundDrain(options, "focus");
    expect(b.events).toEqual(["config", "pending"]);

    // Exactly at the boundary: elapsed >= the window is eligible.
    c.set(T0 + FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(options, "focus");
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);

    // ...and that attempt reset the window, so the next tick is paced again.
    c.set(T0 + FOCUS_DEBOUNCE_MS + MINUTE);
    await resumeBackgroundDrain(options, "focus");
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);
  });

  test("the mount attempt burns the window: a tick right after a page load does nothing", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();

    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(b.events).toEqual(["config", "pending"]);

    c.set(T0 + MINUTE);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toEqual(["config", "pending"]);
  });

  test("the mount latch stays permanent — an eligible tick does NOT reopen it", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });

    // Long past the window: the FOCUS entry is eligible...
    c.set(T0 + 10 * FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);

    // ...but the MOUNT entry is not, ever. A remount is still not a re-drain.
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);
  });
});

describe("I3 focus re-check — what an eligible tick actually does", () => {
  test("an eligible tick with an OPEN vault drains the backlog the mount only counted", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const c = clock();

    // The page load almost always looks like this: locked, counted, waiting.
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(b.queue()).toHaveLength(2);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The user unlocked somewhere along the way and came back an hour later.
    const rec = recordingIngest(b);
    c.set(T0 + FOCUS_DEBOUNCE_MS + MINUTE);
    await resumeBackgroundDrain(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        now: c.now,
        ingest: (_d, items) => rec.run(items),
      }),
      "focus",
    );

    expect(rec.calls).toEqual([[item("m1"), item("m2")]]);
    expect(b.queue()).toHaveLength(0);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
  });

  test("an eligible tick with a LOCKED vault re-counts and never reaches unlock", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });

    // The exploding fixture fails the run loudly if the focus path ever tries
    // to open the vault. It counts, and stops.
    c.set(T0 + FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);
    expect(b.queue()).toHaveLength(1);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(1);
  });

  test("a focus attempt enters through the SHARED lane, behind the work already on it", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = enqueueDrainWork(async () => {
      b.events.push("holder:start");
      await held;
      b.events.push("holder:end");
    });

    const rec = recordingIngest(b);
    const armed = resumeBackgroundDrain(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        now: c.now,
        ingest: (_d, items) => rec.run(items),
      }),
      "focus",
    );

    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(b.events).toEqual(["holder:start"]);

    release();
    await holding;
    await armed;

    expect(b.events.slice(0, 3)).toEqual(["holder:start", "holder:end", "config"]);
    expect(b.queue()).toHaveLength(0);
  });

  test("a focus tick never rejects, even when the client throws", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    const options = drainOptions(b, { tcw: explodingVaultTcw(true), now: c.now });
    const exploding = {
      ...b.webhooks,
      getConfig: async () => {
        throw new Error("network is down");
      },
    };
    const settled = await resumeBackgroundDrain(
      { ...options, hooks: { ...options.hooks, webhooks: exploding } },
      "focus",
    ).then(
      () => "resolved",
      () => "rejected",
    );
    expect(settled).toBe("resolved");
    expect(readBackgroundDrainRecord()?.connectors[0]?.phase).toBe("unavailable");
  });
});

describe("I3 focus re-check — the ticks that burn nothing", () => {
  test("a signed-out tick is free: it does not burn the window", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(b.events).toEqual(["config", "pending"]);

    // Signed out and eligible: zero calls, and — the point of the test — no
    // attempt recorded.
    c.set(T0 + FOCUS_DEBOUNCE_MS + MINUTE);
    await resumeBackgroundDrain(drainOptions(b, { tcw: null, now: c.now }), "focus");
    expect(b.events).toEqual(["config", "pending"]);

    // One minute later a signed-in tick still fires. It could not, had the
    // signed-out tick burned the window.
    c.set(T0 + FOCUS_DEBOUNCE_MS + 2 * MINUTE);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);
  });

  test("the dark latch survives every eligible tick — one probe per page load", async () => {
    const b = backend({ config: { status: "feature-dark" } });
    const c = clock();
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(b.events).toEqual(["config"]);
    expect(readBackgroundDrainRecord()?.featureDark).toBe(true);

    // A whole day of a tab being focused, well past every window boundary.
    for (const at of [1, 2, 3, 10, 24]) {
      c.set(T0 + at * FOCUS_DEBOUNCE_MS);
      await resumeBackgroundDrain(
        drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
        "focus",
      );
    }
    // Still exactly one probe. Only a reload re-probes.
    expect(b.events).toEqual(["config"]);
  });
});

describe("I3 focus re-check — interplay with the I2 unlock re-arm", () => {
  test("an unlock re-arm bypasses the window but still records its attempt", async () => {
    const b = backend({ pending: [item("m1")] });
    const c = clock();

    // Mount, then an unlock one minute later: not paced, so it runs.
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    c.set(T0 + MINUTE);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "unlock",
    );
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);

    // The unlock attempt pushed the next focus tick out by a FULL window from
    // the unlock — not from the mount.
    c.set(T0 + FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toEqual(["config", "pending", "config", "pending"]);

    c.set(T0 + MINUTE + FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), now: c.now }),
      "focus",
    );
    expect(b.events).toHaveLength(6);
  });

  test("sign-out → sign-in inside ONE page load is picked up by the next eligible tick", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const c = clock();

    // User A's page load: locked, counted.
    await start(b, { tcw: explodingVaultTcw(false), now: c.now });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // Sign-out clears the record — and only the record (I1/§1.5).
    clearBackgroundDrainRecord();
    expect(readBackgroundDrainRecord()).toBeNull();

    // Signing back in does NOT re-arm the mount: the recorded trade-off.
    const rec = recordingIngest(b);
    await start(b, {
      tcw: explodingVaultTcw(true),
      now: c.now,
      ingest: (_d, items) => rec.run(items),
    });
    expect(b.events).toEqual(["config", "pending"]);
    expect(rec.calls).toHaveLength(0);

    // The next eligible focus tick is what covers it — the whole point of
    // trading the boolean for a timestamp.
    c.set(T0 + FOCUS_DEBOUNCE_MS);
    await resumeBackgroundDrain(
      drainOptions(b, {
        tcw: explodingVaultTcw(true),
        now: c.now,
        ingest: (_d, items) => rec.run(items),
      }),
      "focus",
    );
    expect(rec.calls).toEqual([[item("m1"), item("m2")]]);
    expect(b.queue()).toHaveLength(0);
  });
});

// ── Audit fixes: the record store under an account switch, and pruning ─
//
// Two majors from the drain-UX security audit, pinned RED-first:
//
//  1. `clearBackgroundDrainRecord()` was defeated by both write paths — a
//     drain run (or a still-unwinding Settings publish) that STARTED under
//     account A could commit AFTER App's signOut cleared the record,
//     repopulating it with A's counts while B is signed in. The store now
//     carries a GENERATION: every publisher captures it when its work begins,
//     the clear advances it, and a stale capture's commit is DROPPED.
//  2. `commitConnectorRecords` never pruned, so a disconnected connector's
//     entry (enabled, N pending, vault locked) pinned the badge at a stale
//     count for the rest of the page load. The headless end-of-run commit is
//     now AUTHORITATIVE — the run enumerated every connector, so its result
//     set REPLACES the entry set — while Settings publishes stay single-source
//     upserts, and the disconnect flow removes its entry explicitly.

describe("I0 record store — a clear strands in-flight runs (account switch)", () => {
  /** A backend whose config poll parks until the test releases it — the run
   *  is genuinely on the wire when the account switches underneath it. */
  function gatedBackend(b: FakeBackend) {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const webhooks: ConnectorWebhooksClient = {
      ...b.webhooks,
      getConfig: async () => {
        await held;
        return b.webhooks.getConfig();
      },
    };
    return { webhooks, release: () => release() };
  }

  test("an in-flight headless run's end-of-run commit is dropped by a mid-run clear", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    // Account A's page load: the mount counts the locked queue.
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // A re-armed run starts under A and stalls on the wire…
    const gate = gatedBackend(b);
    const options = drainOptions(b, { tcw: explodingVaultTcw(false) });
    const inflight = resumeBackgroundDrain(
      { ...options, hooks: { ...options.hooks, webhooks: gate.webhooks } },
      "unlock",
    );

    // …and A signs out while it is in flight. The clear must win: nothing
    // that STARTED under A may put A's counts back for the next account.
    const sub = listen();
    clearBackgroundDrainRecord();
    expect(sub.count()).toBe(1);
    expect(readBackgroundDrainRecord()).toBeNull();

    gate.release();
    await inflight;

    // The stranded commit changed nothing and notified nobody.
    expect(readBackgroundDrainRecord()).toBeNull();
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
    expect(sub.count()).toBe(1);
    sub.unsubscribe();
  });

  test("the clear strands an in-flight run even when the record is still empty", async () => {
    const b = backend({ pending: [item("m1")] });
    const gate = gatedBackend(b);
    const options = drainOptions(b, { tcw: explodingVaultTcw(false) });
    const inflight = maybeStartBackgroundDrain({
      ...options,
      hooks: { ...options.hooks, webhooks: gate.webhooks },
    });

    // Sign-out lands before the FIRST commit ever did: there is nothing to
    // null out, but the account boundary still has to advance — otherwise the
    // in-flight mount repopulates the record for the next account.
    clearBackgroundDrainRecord();
    gate.release();
    await inflight;

    expect(readBackgroundDrainRecord()).toBeNull();
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
  });

  test("a Settings publish carrying a pre-clear capture is dropped; a fresh capture flows", () => {
    const locked = { pendingCount: 3, deadCount: 0, rateLimited: false, blockedReason: null };
    // The section captured this at mount, under account A.
    const mountCapture = readBackgroundDrainGeneration();
    publishBackgroundDrainConnectorState(
      "fireflies",
      settingsState({ queue: locked }),
      true,
      mountCapture,
    );
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(3);

    // A signs out; a still-unwinding sync keeps emitting through the wrapper —
    // the ref-mirror deliberately publishes past unmount, so the generation is
    // the only thing standing between A's counts and B's badge.
    clearBackgroundDrainRecord();
    publishBackgroundDrainConnectorState(
      "fireflies",
      settingsState({ queue: locked }),
      true,
      mountCapture,
    );
    expect(readBackgroundDrainRecord()).toBeNull();
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);

    // Account B's freshly mounted section captures the CURRENT generation and
    // publishes normally.
    publishBackgroundDrainConnectorState(
      "fireflies",
      settingsState({ queue: { ...locked, pendingCount: 1 } }),
      true,
      readBackgroundDrainGeneration(),
    );
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(1);
  });

  test("the Settings section captures its generation at mount and hands it to the publish (source-asserted)", () => {
    const section = readFileSync(join(import.meta.dir, "BackgroundSyncSection.tsx"), "utf8");
    // Captured ONCE, when the section instance begins — not read fresh at each
    // publish, which would defeat the guard exactly the way the audit found.
    expect(section).toContain("readBackgroundDrainGeneration");
    const at = section.indexOf("publishBackgroundDrainConnectorState(");
    expect(at).toBeGreaterThan(0);
    const call = section.slice(at, section.indexOf(");", at));
    expect(call).toContain("publishGeneration");
  });
});

describe("I0 record store — the headless commit is authoritative (pruning)", () => {
  test("the next headless run DROPS the entry for a connector no longer connected", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The user disconnected the connector; its store row is gone. The re-armed
    // run enumerates every connector, so its result set IS the record — a
    // merge would leave the old entry pinning the badge at a count nobody can
    // act on for the rest of the page load.
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), connection: null }),
      "unlock",
    );
    expect(readBackgroundDrainRecord()?.connectors).toEqual([]);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
  });

  test("connectors the run still sees keep their entries while the dropped one goes", async () => {
    const b = backend({ pending: [item("m1")] });
    const twin: ConnectorDescriptor = { ...fireflies, source: "fireflies-two" };
    await start(b, {
      tcw: explodingVaultTcw(false),
      connectors: [fireflies, twin],
    });
    expect(readBackgroundDrainRecord()?.connectors.map((e) => e.source)).toEqual([
      "fireflies",
      "fireflies-two",
    ]);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The twin was disconnected. Connection reads are sequential in connector
    // order, so a scripted answer per read is deterministic.
    const answers: (ConnectorConnection | null)[] = [connection(), null];
    const options = drainOptions(b, {
      tcw: explodingVaultTcw(false),
      connectors: [fireflies, twin],
    });
    await resumeBackgroundDrain(
      {
        ...options,
        hooks: {
          ...options.hooks,
          getConnection: async () => ({ ok: true, data: answers.shift() ?? null }),
        },
      },
      "unlock",
    );

    expect(readBackgroundDrainRecord()?.connectors.map((e) => e.source)).toEqual([
      "fireflies",
    ]);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(1);
  });

  test("a value-equal commit in a different order neither notifies nor swaps the reference", async () => {
    // Guard-pin for the equality comparison being SOURCE-KEYED: the replacing
    // headless run may enumerate in a different order than the held record —
    // same facts in a new order are not a change and must not wake the badge.
    const twin: ConnectorDescriptor = { ...fireflies, source: "fireflies-two" };
    const locked = { pendingCount: 1, deadCount: 0, rateLimited: false, blockedReason: null };
    publishBackgroundDrainConnectorState("fireflies", settingsState({ queue: locked }), true);
    publishBackgroundDrainConnectorState("fireflies-two", settingsState({ queue: locked }), true);
    const held = readBackgroundDrainRecord();
    expect(held?.connectors.map((e) => e.source)).toEqual(["fireflies", "fireflies-two"]);

    const sub = listen();
    const b = backend({ pending: [item("m1")] });
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false), connectors: [twin, fireflies] }),
      "unlock",
    );

    expect(sub.count()).toBe(0);
    expect(readBackgroundDrainRecord()).toBe(held);
    sub.unsubscribe();
  });
});

describe("I1 badge — disconnect prunes the connector's entry", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("removing the entry notifies once and the badge stops counting it", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // The teardown finished: the connector is gone, and so is its claim on the
    // header. Without this, the next headless run is a focus-tick (or an
    // unlock) away — the badge would pin the stale count until then.
    const sub = listen();
    removeBackgroundDrainConnectorRecord(fireflies.source);
    expect(sub.count()).toBe(1);
    expect(readBackgroundDrainRecord()?.connectors).toEqual([]);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);
    sub.unsubscribe();
  });

  test("removing an absent source or from a null record is a silent no-op", () => {
    const sub = listen();
    removeBackgroundDrainConnectorRecord("fireflies"); // record is null
    expect(sub.count()).toBe(0);
    expect(readBackgroundDrainRecord()).toBeNull();

    publishBackgroundDrainConnectorState("fireflies", settingsState(), true);
    expect(sub.count()).toBe(1);
    removeBackgroundDrainConnectorRecord("granola"); // not in the record
    expect(sub.count()).toBe(1);
    expect(readBackgroundDrainRecord()?.connectors).toHaveLength(1);
    sub.unsubscribe();
  });

  test("remove is a generation boundary: an in-flight run's commit from before it is dropped", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    await start(b, { tcw: explodingVaultTcw(false) });
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(2);

    // A re-armed run starts while the connector is still connected, and
    // stalls on the wire…
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated: ConnectorWebhooksClient = {
      ...b.webhooks,
      getConfig: async () => {
        await held;
        return b.webhooks.getConfig();
      },
    };
    const options = drainOptions(b, { tcw: explodingVaultTcw(false) });
    const inflight = resumeBackgroundDrain(
      { ...options, hooks: { ...options.hooks, webhooks: gated } },
      "unlock",
    );

    // …and the user disconnects mid-flight. The remove settles the badge…
    removeBackgroundDrainConnectorRecord(fireflies.source);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);

    // …and the stranded commit may not resurrect the removed entry: remove is
    // a generation boundary exactly like the sign-out clear.
    release();
    await inflight;
    expect(readBackgroundDrainRecord()?.connectors).toEqual([]);
    expect(badgePendingCount(readBackgroundDrainRecord())).toBe(0);

    // A FRESH post-remove attempt owns the new generation and still commits —
    // the boundary strands the past, never the future.
    await resumeBackgroundDrain(
      drainOptions(b, { tcw: explodingVaultTcw(false) }),
      "unlock",
    );
    expect(readBackgroundDrainRecord()?.connectors[0]?.pendingCount).toBe(2);
  });

  test("the disconnect orchestration clears the entry at teardown success (source-asserted)", () => {
    const dialog = read("ConnectorDialog.tsx");
    expect(dialog).toContain("removeBackgroundDrainConnectorRecord");
    // In the SUCCESS branch only: after the orchestrator's done flag, before
    // the parent is told — never on the partial-teardown path, where the
    // connector is NOT disconnected and its count still stands.
    const from = dialog.indexOf("if (!final.done)");
    expect(from).toBeGreaterThan(0);
    // The slice runs to the success branch's `onDisconnected()` — the removal
    // sits between the done check and the parent being told, so a partial
    // teardown (which returns first) can never reach it.
    const success = dialog.slice(from, dialog.indexOf("onDisconnected();", from));
    expect(success).toContain("removeBackgroundDrainConnectorRecord(descriptor.source)");
    // And lib/ stays clean: the lifecycle orchestrator knows nothing of the
    // chat-side record store.
    expect(read("../lib/connectors/connectorLifecycle.ts")).not.toContain(
      "removeBackgroundDrainConnectorRecord",
    );
  });
});

describe("I3 focus re-check — wiring (source-asserted)", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("the focus listener follows the A1 idiom: window focus, in the mount effect, symmetric cleanup", () => {
    const drain = read("useBackgroundDrain.ts");
    const at = drain.indexOf("export function useBackgroundDrain");
    expect(at).toBeGreaterThan(0);
    const hook = drain.slice(at);
    expect(hook).toContain('window.addEventListener("focus"');
    expect(hook).toContain('window.removeEventListener("focus"');
    expect(hook).toContain('"focus"');
    // The A1 idiom is a plain focus event with the gating in the callee — no
    // second lane, no visibilitychange path, and above all no polling.
    expect(drain).not.toContain("visibilitychange");
    expect(drain).not.toContain("setInterval");
    expect(drain).not.toContain("setTimeout");
    expect(drain).not.toContain("requestIdleCallback");
  });

  test("the once-per-session boolean is gone; the mount latch is the timestamp, never the window", () => {
    const drain = read("useBackgroundDrain.ts");
    expect(drain).not.toContain("sessionStarted");
    expect(drain).toContain("lastAttemptStartedAt");
    expect(drain).toContain("FOCUS_DEBOUNCE_MS");

    const from = drain.indexOf("export function maybeStartBackgroundDrain");
    expect(from).toBeGreaterThan(0);
    // The function body alone — up to its closing brace, so the next
    // declaration's prose cannot answer for it.
    const mount = drain.slice(from, drain.indexOf("\n}\n", from));
    // Permanent, never time-based: any prior attempt blocks the mount path for
    // the rest of the page load, exactly as the boolean did.
    expect(mount).toContain("lastAttemptStartedAt !== 0");
    expect(mount).not.toContain("FOCUS_DEBOUNCE_MS");

    // App.tsx hosts no I3 listener — the drainer's own effect already sits
    // behind the shell's signed-in gate, and its cleanup IS the sign-out
    // teardown.
    const app = read("../App.tsx");
    expect(app).not.toContain("FOCUS_DEBOUNCE_MS");
    expect(app).not.toContain("resumeBackgroundDrain");
  });
});
