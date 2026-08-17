// RED-first contract for the HEADLESS webhook-queue drain (the app-shell half
// of "next visit").
//
// Phase 2 wired the drain to Settings → Connectors; this module moves the
// trigger to any authenticated visit WITHOUT changing what the drain does. The
// rules under test are the drain-trigger handoff's non-negotiables:
//
//   1. MOUNT NEVER UNLOCKS — a locked vault is a silent no-op, and
//      `secrets.unlock` is not even wired into the headless path;
//   2. no double drain — the headless run and the Settings surface share one
//      serialized lane, so overlapping mounts cannot fetch a meeting twice;
//   3. a route-disabled 404 latches DARK for the whole session — one cheap
//      probe, then silence (this is the default deployment today);
//   4. signed-out is a no-op that does not consume the session's one attempt;
//   5. once per app session — remounts and re-renders never re-run it;
//   6. failures stay quiet — no throw, no unhandled rejection, nothing rendered.
//
// Idioms follow the sibling suites: fakes over the typed client (no DOM
// harness), an exploding-unlock tcw (targetedSync.test.ts), and source
// assertions for component plumbing that cannot be imported into a bun test
// process (ConnectorsCard.test.ts, encryptionGrant.test.ts "App wiring").

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  BackgroundDrainer,
  buildHeadlessDrainDeps,
  enqueueDrainWork,
  maybeStartBackgroundDrain,
  readBackgroundDrainRecord,
  resetBackgroundDrainForTests,
  type BackgroundDrainHooks,
} from "./useBackgroundDrain";
import {
  initialBackgroundSyncState,
  loadOnMount,
  type BackgroundSyncDeps,
} from "./backgroundSyncState";
import { CONNECTORS } from "@/lib/connectors/registry";
import {
  createConnectorWebhooksClient,
  type ConnectorAckResult,
  type ConnectorWebhookConfigPoll,
  type ConnectorWebhookPending,
  type ConnectorWebhooksClient,
  type ConnectorWebhooksResult,
} from "@/lib/connectors/webhooksApi";
import type {
  TargetedIngestResult,
  TargetedQueueItem,
} from "@/lib/connectors/targetedSync";
import type {
  ConnectorConnection,
  ConnectorDescriptor,
} from "@/lib/connectors/types";

// ── Fixtures ─────────────────────────────────────────────────────────

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

/** A tcw whose vault records unlock attempts instead of prompting. */
function tcwWithVault(unlocked: boolean) {
  let unlockCalls = 0;
  const tcw = {
    secrets: {
      isUnlocked: unlocked,
      unlock: async () => {
        unlockCalls += 1;
        return { ok: true };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, unlockCalls: () => unlockCalls };
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

// ── A fake companion backend with a real queue state machine ─────────
//
// `drain`/`getPending` reflect the live queue; `acknowledge` settles what the
// caller stored, exactly as the real routes do. Config-management and purge
// routes EXPLODE: the headless drain has no business calling any of them.

interface FakeBackend {
  webhooks: ConnectorWebhooksClient;
  events: string[];
  queue: () => TargetedQueueItem[];
}

function backend(
  opts: {
    pending?: TargetedQueueItem[];
    enabled?: boolean;
    config?:
      | ConnectorWebhooksResult<ConnectorWebhookConfigPoll>
      | (() => Promise<ConnectorWebhooksResult<ConnectorWebhookConfigPoll>>);
    holdDrain?: Promise<void>;
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
      if (typeof opts.config === "function") return opts.config();
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
      if (opts.holdDrain) await opts.holdDrain;
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

/** An ingest fake that mirrors the real engine's shape: it "fetches" each id
 *  (with an async gap so interleaving would be visible), then acknowledges
 *  what it stored — storage before ack. */
function recordingIngest(b: FakeBackend, fetched: string[]) {
  const calls: TargetedQueueItem[][] = [];
  const run = async (
    items: readonly TargetedQueueItem[],
  ): Promise<TargetedIngestResult> => {
    calls.push([...items]);
    b.events.push("ingest:start");
    for (const it of items) {
      await Promise.resolve();
      fetched.push(it.meetingId);
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
    const acknowledged = ack.status === "ok" ? ack.value.acknowledged : 0;
    return {
      ok: true,
      data: {
        stored: items.length,
        inserted: items.length,
        updated: 0,
        acknowledged,
        alreadySettled:
          ack.status === "ok" ? ack.value.alreadySettled : 0,
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

const neverIngest = async (): Promise<TargetedIngestResult> => {
  throw new Error("ingest must not run in this scenario");
};

function countingConnection(data: ConnectorConnection | null) {
  let reads = 0;
  const getConnection: NonNullable<BackgroundDrainHooks["getConnection"]> =
    async () => {
      reads += 1;
      return { ok: true, data };
    };
  return { getConnection, reads: () => reads };
}

interface StartOverrides {
  tcw?: TinyCloudWeb | null;
  connection?: ConnectorConnection | null;
  connectors?: readonly ConnectorDescriptor[];
  ingest?: (
    descriptor: ConnectorDescriptor,
    items: readonly TargetedQueueItem[],
  ) => Promise<TargetedIngestResult>;
  webhooks?: ConnectorWebhooksClient;
}

function start(b: FakeBackend, over: StartOverrides = {}) {
  const conn = countingConnection(
    over.connection === undefined ? connection() : over.connection,
  );
  const promise = maybeStartBackgroundDrain({
    tcw: over.tcw === undefined ? explodingVaultTcw(true) : over.tcw,
    sessionStore: SESSION,
    backendUrl: BACKEND,
    hooks: {
      webhooks: over.webhooks ?? b.webhooks,
      getConnection: conn.getConnection,
      connectors: over.connectors ?? [fireflies],
      ingest: over.ingest ?? (() => neverIngest()),
    },
  });
  return { promise, connectionReads: conn.reads };
}

/** Settings-shaped deps over the same fake backend — what
 *  `BackgroundSyncSection` hands `loadOnMount`. */
function settingsDeps(b: FakeBackend, fetched: string[]): { deps: BackgroundSyncDeps } {
  const rec = recordingIngest(b, fetched);
  const deps: BackgroundSyncDeps = {
    source: "fireflies",
    webhooks: b.webhooks,
    secrets: {
      isUnlocked: () => true,
      unlock: async () => {
        throw new Error("the mount-time load must never unlock");
      },
    },
    ingest: (items) => rec.run(items),
  };
  return { deps };
}

function countEvents(b: FakeBackend, name: string): number {
  return b.events.filter((e) => e === name).length;
}

beforeEach(() => {
  resetBackgroundDrainForTests();
});

// ── Nothing rendered, ever ───────────────────────────────────────────

describe("user-visible surface", () => {
  test("BackgroundDrainer renders NOTHING and starts nothing during render", () => {
    const { tcw } = tcwWithVault(true);
    const html = renderToStaticMarkup(
      <BackgroundDrainer tcw={tcw} sessionStore={SESSION} backendUrl={BACKEND} />,
    );
    expect(html).toBe("");
    // Rendering is not starting: the drain belongs to the mount effect.
    expect(readBackgroundDrainRecord()).toBeNull();
  });
});

// ── Constraint 1: MOUNT NEVER UNLOCKS ────────────────────────────────

describe("mount never unlocks", () => {
  test("a locked vault with queued meetings never reaches tcw.secrets.unlock", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const vault = tcwWithVault(false);
    const { promise } = start(b, { tcw: vault.tcw });
    await promise;
    expect(vault.unlockCalls()).toBe(0);
  });

  test("the headless deps hard-wire unlock to a refusal that never touches the vault", async () => {
    const b = backend();
    const vault = tcwWithVault(false);
    const deps = buildHeadlessDrainDeps(vault.tcw, fireflies, b.webhooks);
    const result = await deps.secrets.unlock();
    expect(result.ok).toBe(false);
    expect(vault.unlockCalls()).toBe(0);
  });

  test("the module does not even import the interactive unlock helper", () => {
    const source = readFileSync(join(import.meta.dir, "useBackgroundDrain.ts"), "utf8");
    expect(source).not.toContain("unlockSecrets");
  });
});

// ── Locked vault: silent no-op, count recorded ───────────────────────

describe("locked vault", () => {
  test("counts what is waiting, drains nothing, ingests nothing, throws nothing", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const { promise } = start(b, { tcw: explodingVaultTcw(false) });
    await promise;
    // The exact conversation: one config poll, one passive count. NO drain —
    // a locked visit must not burn a delivery's attempts.
    expect(b.events).toEqual(["config", "pending"]);
    expect(b.queue().length).toBe(2);
    const record = readBackgroundDrainRecord();
    expect(record?.connectors).toHaveLength(1);
    expect(record?.connectors[0]?.pendingCount).toBe(2);
  });
});

// ── Unlocked vault: drain → ingest (sequential) → settle ─────────────

describe("unlocked vault", () => {
  test("surfaced ids are handed to ONE sequential ingest run and the queue settles", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const fetched: string[] = [];
    const rec = recordingIngest(b, fetched);
    const { promise } = start(b, {
      tcw: explodingVaultTcw(true),
      ingest: (_d, items) => rec.run(items),
    });
    await promise;
    // One ingest call carrying the whole surfaced queue in order — never a
    // per-meeting fan-out (TinyCloud drops concurrent responses on one space).
    expect(rec.calls).toEqual([[item("m1"), item("m2")]]);
    expect(fetched).toEqual(["m1", "m2"]);
    expect(b.queue().length).toBe(0);
    // Strict phase ordering: the drain completes before ingest starts, the
    // ack lands before the re-read. No overlap anywhere.
    expect(b.events).toEqual([
      "config",
      "drain:start",
      "drain:end",
      "ingest:start",
      "ack:m1,m2",
      "ingest:end",
      "pending",
    ]);
  });
});

// ── Constraint 3: dark latches for the whole session ─────────────────

describe("dark latch", () => {
  test("a route-disabled 404 is ONE cheap probe; a remount does not re-probe", async () => {
    const b = backend({ config: { status: "feature-dark" } });
    const first = start(b);
    await first.promise;
    expect(b.events).toEqual(["config"]);
    expect(readBackgroundDrainRecord()?.featureDark).toBe(true);

    // The app-shell remount (route change, sign-out/in) — still one probe.
    const second = start(b);
    await second.promise;
    expect(b.events).toEqual(["config"]);
    expect(second.connectionReads()).toBe(0);
  });

  test("dark latches WITHIN a run: later connectors are not probed or read", async () => {
    const secondSource: ConnectorDescriptor = { ...fireflies, source: "fireflies-two" };
    const b = backend({ config: { status: "feature-dark" } });
    const { promise, connectionReads } = start(b, {
      connectors: [fireflies, secondSource],
    });
    await promise;
    expect(b.events).toEqual(["config"]);
    expect(connectionReads()).toBe(1);
  });
});

// ── Constraint 4: signed-out is a free no-op ─────────────────────────

describe("signed-out", () => {
  test("no tcw → zero calls, and the session's one attempt is NOT consumed", async () => {
    const b = backend({ pending: [item("m1")] });
    const withoutTcw = start(b, { tcw: null });
    await withoutTcw.promise;
    expect(b.events).toEqual([]);
    expect(withoutTcw.connectionReads()).toBe(0);
    expect(readBackgroundDrainRecord()).toBeNull();

    // The session that BECOMES ready still gets its drain.
    const ready = start(b, { tcw: explodingVaultTcw(false) });
    await ready.promise;
    expect(countEvents(b, "config")).toBe(1);
  });

  test("no bearer token → the real client resolves signed-out with ZERO network", async () => {
    const fetchCalls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const signedOut = {
      getToken: () => null,
      isExpired: () => false,
      clear: () => {},
    } as unknown as SessionStore;
    const real = createConnectorWebhooksClient(BACKEND, {
      sessionStore: signedOut,
      fetchImpl,
    });
    const b = backend();
    const { promise } = start(b, { webhooks: real, tcw: explodingVaultTcw(true) });
    await promise;
    expect(fetchCalls).toEqual([]);
    expect(readBackgroundDrainRecord()?.connectors[0]?.phase).toBe("signed-out");
  });
});

// ── Constraint 5: once per app session ───────────────────────────────

describe("once per session", () => {
  test("a finished run is never repeated by a remount or re-render", async () => {
    const b = backend();
    const first = start(b, { tcw: explodingVaultTcw(true) });
    await first.promise;
    expect(b.events).toEqual(["config", "drain:start", "drain:end"]);

    const second = start(b, { tcw: explodingVaultTcw(true) });
    await second.promise;
    expect(b.events).toEqual(["config", "drain:start", "drain:end"]);
    expect(second.connectionReads()).toBe(0);
  });

  test("two synchronous starts collapse into one run", async () => {
    const b = backend();
    const first = start(b, { tcw: explodingVaultTcw(true) });
    const second = start(b, { tcw: explodingVaultTcw(true) });
    await Promise.all([first.promise, second.promise]);
    expect(countEvents(b, "config")).toBe(1);
  });
});

// ── Constraint 2: no double drain across the two surfaces ────────────

describe("no double drain", () => {
  test("drainer then Settings, overlapping: each meeting is fetched exactly once", async () => {
    const hold = deferred();
    const b = backend({ pending: [item("m1")], holdDrain: hold.promise });
    const fetched: string[] = [];
    const rec = recordingIngest(b, fetched);

    const headless = start(b, {
      tcw: explodingVaultTcw(true),
      ingest: (_d, items) => rec.run(items),
    });
    await tick();
    // The headless drain is mid-flight…
    expect(countEvents(b, "drain:start")).toBe(1);

    // …when Settings mounts and enqueues its own load, as the section does.
    const settings = settingsDeps(b, fetched);
    let state = initialBackgroundSyncState();
    const settingsDone = enqueueDrainWork(() =>
      loadOnMount(settings.deps, (updater) => {
        state = updater(state);
      }),
    );
    await tick();
    // Serialized: Settings has not touched the backend while the drain runs.
    expect(countEvents(b, "config")).toBe(1);

    hold.resolve();
    await Promise.all([headless.promise, settingsDone]);

    // Both paths completed; m1 was fetched ONCE, by the headless run, and
    // Settings saw the settled queue.
    expect(fetched).toEqual(["m1"]);
    expect(b.queue().length).toBe(0);
    expect(countEvents(b, "config")).toBe(2);
    expect(state.queue?.pendingCount).toBe(0);
  });

  test("Settings then drainer, overlapping: the drainer waits and drains an empty queue", async () => {
    const hold = deferred();
    const b = backend({ pending: [item("m1")], holdDrain: hold.promise });
    const fetched: string[] = [];

    const settings = settingsDeps(b, fetched);
    let state = initialBackgroundSyncState();
    const settingsDone = enqueueDrainWork(() =>
      loadOnMount(settings.deps, (updater) => {
        state = updater(state);
      }),
    );
    await tick();
    expect(countEvents(b, "drain:start")).toBe(1);

    const rec = recordingIngest(b, fetched);
    const headless = start(b, {
      tcw: explodingVaultTcw(true),
      ingest: (_d, items) => rec.run(items),
    });
    await tick();
    // The headless run is queued behind Settings: nothing from it yet — not
    // even the connection read.
    expect(countEvents(b, "config")).toBe(1);
    expect(headless.connectionReads()).toBe(0);

    hold.resolve();
    await Promise.all([settingsDone, headless.promise]);

    expect(fetched).toEqual(["m1"]);
    expect(rec.calls).toEqual([]); // the headless drain found nothing left
    expect(b.queue().length).toBe(0);
    expect(state.queue?.pendingCount).toBe(0);
  });
});

// ── Constraint 6: failures stay quiet ────────────────────────────────

describe("failures stay quiet", () => {
  test("a backend outage is a silent single attempt; the queue is intact", async () => {
    const b = backend({ config: { status: "offline" }, pending: [item("m1")] });
    const first = start(b, { tcw: explodingVaultTcw(true) });
    await first.promise;
    expect(b.events).toEqual(["config"]);
    expect(b.queue().length).toBe(1);
    expect(readBackgroundDrainRecord()?.connectors[0]?.phase).toBe("unavailable");

    // One attempt per session — an outage is not retried (the backend paces
    // drains anyway; the next visit is the retry).
    const second = start(b, { tcw: explodingVaultTcw(true) });
    await second.promise;
    expect(b.events).toEqual(["config"]);
  });

  test("a THROWING client neither rejects the start nor poisons the lane", async () => {
    const b = backend({
      config: async () => {
        throw new Error("boom");
      },
    });
    const { promise } = start(b, { tcw: explodingVaultTcw(true) });
    await expect(promise).resolves.toBeUndefined();
    // The shared lane still serves the Settings surface afterwards.
    const after = await enqueueDrainWork(async () => "still-works");
    expect(after).toBe("still-works");
  });

  test("a hung backend never blocks the caller", async () => {
    const b = backend({
      config: () => new Promise<never>(() => {}),
    });
    const { promise } = start(b, { tcw: explodingVaultTcw(true) });
    // The start call hands back a pending promise and control immediately;
    // nothing is awaited on the render path and nothing has thrown.
    expect(promise).toBeInstanceOf(Promise);
    await tick();
    expect(b.events).toEqual(["config"]);
    // (The lane is reset per test; a real hang is bounded by the browser's
    // own fetch timeout and holds only the drain lane, not the app.)
  });
});

// ── Wiring (source-asserted, as ConnectorsCard.test.ts does) ─────────

describe("app wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("App mounts the drainer behind the SAME ready gate, with the shell's own deps", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("<BackgroundDrainer");
    expect(at).toBeGreaterThan(0);
    expect(app.slice(at - 200, at)).toContain('state === "ready" && tcw &&');
    const usage = app.slice(at, app.indexOf("/>", at));
    expect(usage).toContain("tcw={tcw}");
    expect(usage).toContain("sessionStore={sessionStoreRef.current}");
    expect(usage).toContain("backendUrl={BACKEND_URL}");
  });

  test("the Settings surface routes its drain-capable entries through the shared lane", () => {
    const section = read("BackgroundSyncSection.tsx");
    expect(section).toContain("enqueueDrainWork(() => loadOnMount(deps, emit))");
    expect(section).toContain("enqueueDrainWork(() => syncQueuedMeetings(deps, emit))");
  });

  test("the headless module reuses the typed client, the gate rule, and stays sequential", () => {
    const source = read("useBackgroundDrain.ts");
    expect(source).toContain("createConnectorWebhooksClient(backendUrl, { sessionStore })");
    expect(source).toContain("supportsBackgroundNotifications(");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("Promise.all");
  });
});

// ── google-meet is not on this lane (WP-C) ───────────────────────────
//
// The drainer serves the Option-C webhook queue. Google Meet has no webhook —
// its sync is the separate session-start lane in `useGmeetSessionSync` — so the
// supports-gate skips it, and that skip is INTENTIONAL rather than an oversight
// the flip commit is supposed to fix.
//
// Flip-agnostic by construction: the descriptor is built here in its POST-flip
// shape and handed to the drain through the `connectors` seam, so this stays
// green both while the registry row is `coming-soon` and after it flips.

describe("google-meet is skipped at the supports gate", () => {
  const gmeetAvailable: ConnectorDescriptor = {
    id: "google-meet",
    name: "Google Meet",
    description: "Sync Google Meet recordings and captions.",
    status: "available",
    secretName: "REFRESH_TOKEN",
    secretScope: "google-meet",
    source: "google-meet",
  };

  test("an available, CONNECTED google-meet row makes no webhook call at all", async () => {
    const b = backend({ pending: [item("m1")] });
    const { promise, connectionReads } = start(b, {
      connectors: [gmeetAvailable],
      connection: connection({ connectorId: "google-meet", status: "connected" }),
    });
    await promise;
    // Discovery reads the row's connection (cheap SQL, never the vault) and
    // then stops: no `GET /config`, no drain, no ingest.
    expect(connectionReads()).toBe(1);
    expect(b.events).toEqual([]);
    // And nothing is recorded for it — a badge entry would promise a queue
    // this connector does not have.
    expect(readBackgroundDrainRecord()?.connectors).toEqual([]);
  });

  test("it does not interrupt the fireflies row beside it", async () => {
    const b = backend({ pending: [item("m1"), item("m2")] });
    const { promise } = start(b, {
      tcw: explodingVaultTcw(false),
      connectors: [gmeetAvailable, fireflies],
    });
    await promise;
    expect(b.events).toEqual(["config", "pending"]);
    const record = readBackgroundDrainRecord();
    expect(record?.connectors.map((e) => e.source)).toEqual(["fireflies"]);
    expect(record?.connectors[0]?.pendingCount).toBe(2);
  });
});
