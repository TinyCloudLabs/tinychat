// The HEADLESS webhook-queue drain — the app-shell half of "next visit".
//
// Phase 2 wired the queue drain to the Settings → Connectors surface, so a
// user who chats daily and never opens Settings accumulates queued meetings
// indefinitely. This module moves the TRIGGER to any authenticated visit
// without changing what the drain does: it reuses `loadOnMount` from the
// decision layer verbatim, per connected + supported connector, emitting into
// a module-local state nobody renders.
//
// The rules, restated in code:
//
//  - MOUNT NEVER UNLOCKS. The headless deps hard-wire `secrets.unlock` to a
//    refusal that never touches the vault — the interactive unlock helper is
//    not imported here at all. A locked vault counts what is waiting and stops.
//  - PACED, NEVER POLLED. Attempts are mount ∪ unlock events ∪ focus ticks at
//    least `FOCUS_DEBOUNCE_MS` apart — nothing else. A module-level timestamp
//    (`lastAttemptStartedAt`) absorbs remounts, re-renders and route changes:
//    the mount path runs at most once per page load, and the window is a
//    COMPARISON made when an event arrives, never a wakeup. There are no
//    timers in this module, by design. Each attempt is still one pass with no
//    client-side retries — the backend paces drains (~2 s floor, per-address
//    singleton) and the next trigger is the retry.
//  - NO DOUBLE DRAIN. Every drain-capable entry — this drainer, the Settings
//    mount load, and the user-initiated sync — runs on ONE serialized lane
//    (`enqueueDrainWork`), so an overlapping mount cannot re-surface ids the
//    other path is still ingesting. Storage stays sequential end to end.
//  - DARK LATCHES. A route-disabled 404 is the default deployment today: it
//    costs one probe, is remembered for the whole session, and stops the
//    connector loop.
//  - FAILURES STAY QUIET. Nothing here throws, rejects unhandled, or renders.
//    The Settings surface remains the only place detail lives; this module
//    records counts (`readBackgroundDrainRecord`) and says nothing.
//
// The record is also a STORE (`subscribeBackgroundDrainRecord`), so a surface
// that wants to show the count can follow it without polling — and BOTH paths
// that learn the queue's state publish into it: this drainer at the end of its
// run, and the Settings section after each of its own runs
// (`publishBackgroundDrainConnectorState`, no extra HTTP). Otherwise a Settings
// sync would settle the queue and leave a stale count behind. Two rules keep
// the record honest across time: every publisher captures the store GENERATION
// when its work begins and a commit whose capture is stale (the record was
// cleared mid-flight — an account switch) is dropped; and the drain run's
// end-of-run commit REPLACES the entry set it enumerated, so a disconnected
// connector's entry cannot pin a stale count for the rest of the page load.

import { useEffect } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { CONNECTORS } from "@/lib/connectors/registry";
import {
  getConnection as storeGetConnection,
  type StoreResult,
} from "@/lib/connectors/connectorStore";
import {
  isSecretsUnlocked,
  onSecretsUnlocked,
} from "@/lib/connectors/connectorSecrets";
import {
  ingestQueuedMeetings,
  type TargetedIngestBlockedReason,
  type TargetedIngestResult,
  type TargetedQueueItem,
} from "@/lib/connectors/targetedSync";
import {
  createConnectorWebhooksClient,
  type ConnectorWebhooksClient,
} from "@/lib/connectors/webhooksApi";
import type {
  ConnectorConnection,
  ConnectorDescriptor,
  ConnectorId,
} from "@/lib/connectors/types";
import {
  initialBackgroundSyncState,
  loadOnMount,
  supportsBackgroundNotifications,
  type BackgroundSyncDeps,
  type BackgroundSyncEmit,
  type BackgroundSyncPhase,
  type BackgroundSyncState,
  type IngestSummary,
} from "./backgroundSyncState";

// ── Options ──────────────────────────────────────────────────────────

/** Test seams, following `targetedSync`'s optional-deps idiom. Production
 *  callers pass none of these — the defaults are the real modules. */
export interface BackgroundDrainHooks {
  webhooks?: ConnectorWebhooksClient;
  connectors?: readonly ConnectorDescriptor[];
  getConnection?: (
    tcw: TinyCloudWeb,
    id: ConnectorId,
  ) => Promise<StoreResult<ConnectorConnection | null>>;
  ingest?: (
    descriptor: ConnectorDescriptor,
    items: readonly TargetedQueueItem[],
  ) => Promise<TargetedIngestResult>;
  /** The clock the pacing window is measured against. Production passes none
   *  (`Date.now`); a test crosses the window by RETURNING a bigger number,
   *  which is the whole reason the window is a comparison and not a wakeup. */
  now?: () => number;
}

export interface BackgroundDrainOptions {
  /** Null while signed out — a free no-op that does NOT consume the session's
   *  one attempt. The App gate keeps this non-null in practice. */
  tcw: TinyCloudWeb | null;
  sessionStore: SessionStore;
  backendUrl: string;
  hooks?: BackgroundDrainHooks;
}

/** What the last run of EITHER path found for one connector. Counts only —
 *  never a meeting identifier. */
export interface BackgroundDrainConnectorRecord {
  source: string;
  phase: BackgroundSyncPhase;
  pendingCount: number | null;
  ingestBlocked: TargetedIngestBlockedReason | null;
  /** The Settings surface's fail-closed surfacing gate said "we can't show
   *  what's waiting". A boolean, so no reason string travels with it — a
   *  reader that shows counts must fail closed the same way the surface does. */
  surfaceBlocked: boolean;
  lastIngest: IngestSummary | null;
}

export interface BackgroundDrainRecord {
  featureDark: boolean;
  connectors: BackgroundDrainConnectorRecord[];
}

// ── Session state (module-level by design) ───────────────────────────
//
// One browser session = one module instance, which is exactly the lifetime
// the product decision names. Sign-out/sign-in inside one page load does not
// re-arm the MOUNT path — fewer drains is the safe direction — and the next
// eligible focus tick is what picks that queue up.

/**
 * How long a focus tick must be from the last attempt to earn a new one.
 *
 * The client-side ceiling exists so a day-long chat tab costs a handful of
 * small reads per hour, and so a drain nobody asked for never burns a
 * provider's quota. 45 minutes sits in the middle of the approved [30, 60]
 * band: an absence long enough to have produced a meeting (30/60-minute
 * calendar blocks plus transcription lag) is caught on the first tick back,
 * while a user alt-tabbing all morning still costs one attempt.
 */
export const FOCUS_DEBOUNCE_MS = 45 * 60 * 1000;

/** When the last real attempt STARTED. 0 = never — the mount latch reads this
 *  as "no attempt yet", and it is the only thing the mount path asks. */
let lastAttemptStartedAt = 0;
let featureDark = false;
let drainLane: Promise<unknown> = Promise.resolve();
let record: BackgroundDrainRecord | null = null;
const recordListeners = new Set<() => void>();
/** The record's account boundary. Advanced by every clear (sign-out) and test
 *  reset; a publisher captures it when its work BEGINS and the store drops any
 *  commit whose capture is stale — work that started under one account can
 *  never repopulate the record after the next account arrived. An integer that
 *  never enters the record itself: the record stays counts-only. */
let storeGeneration = 0;

/**
 * The shared serialization lane for everything that may drain and ingest.
 *
 * The headless run and the Settings surface both enter through here, so their
 * work is strictly ordered: whichever starts second sees the queue AFTER the
 * first's acknowledgements landed, and a surfaced id can never be fetched by
 * both. (The backend's dedup and `alreadySettled` make an overlap safe rather
 * than corrupting — this makes it not happen.)
 */
export function enqueueDrainWork<T>(work: () => Promise<T>): Promise<T> {
  const run = drainLane.then(() => work());
  // The lane itself never rejects; the caller's promise still carries the
  // caller's failure.
  drainLane = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The clock, seam-first. Read exactly once per decision, so a tick can never
 *  compare one instant and record another. */
function readClock(options: BackgroundDrainOptions): number {
  return options.hooks?.now?.() ?? Date.now();
}

/**
 * Start the page load's headless drain, if this page load has not had one.
 *
 * Safe to call from every app-shell render: the latch is consumed only when a
 * real attempt begins (a signed-out call is free), and the returned promise
 * never rejects. The check is `!== 0` — PERMANENT, never time-based: any prior
 * attempt, from any trigger, closes the mount path for the rest of the page
 * load. Only the focus trigger consults the pacing window.
 */
export function maybeStartBackgroundDrain(
  options: BackgroundDrainOptions,
): Promise<void> {
  const tcw = options.tcw;
  if (!tcw) return Promise.resolve();
  if (lastAttemptStartedAt !== 0) return Promise.resolve();
  lastAttemptStartedAt = readClock(options);
  // Captured at commit time, not when the lane later runs the work: a sign-out
  // in between strands this run's end-of-run commit on the old generation.
  const generation = storeGeneration;
  return enqueueDrainWork(() =>
    drainConnectedConnectors(tcw, options, generation),
  ).catch(() => {
    // Quiet by contract: the record (when written) is the only trace.
  });
}

/**
 * The shared re-arm entry — I2's unlock and I3's focus tick.
 *
 * `"unlock"` is the strong signal that the counted backlog just became
 * ingestable, so it does NOT consult the pacing window: it just re-enters the
 * same drain the mount would run. `"focus"` is the weak one — a user came back
 * to a tab — so it runs only when at least `FOCUS_DEBOUNCE_MS` has passed since
 * the last attempt STARTED. Either way the work goes through `enqueueDrainWork`,
 * which serializes it behind whatever else is on the lane (the flow that
 * triggered the unlock, a Settings sync, an earlier tick) — the redundant run a
 * Settings sync produces sees an empty queue and the lane makes it safe.
 *
 * The window is BURNED HERE, synchronously at the moment an attempt is
 * committed, not when the lane later runs the work: two ticks inside one window
 * can then never both pass the check. Conversely a tick that attempts nothing —
 * signed out, or dark — burns nothing, because it did not use its turn.
 *
 * Signed out, dark, and a caller-thrown client are all free no-ops: nothing
 * about a re-arm should be able to burn attempts or poison the lane. The
 * returned promise never rejects.
 */
export function resumeBackgroundDrain(
  options: BackgroundDrainOptions,
  trigger: "unlock" | "focus",
): Promise<void> {
  const tcw = options.tcw;
  // Signed out: no listener should exist in production, but a stray call here
  // must still be free (no burn, no enqueue).
  if (!tcw) return Promise.resolve();
  // Dark survives every re-arm. A route-disabled 404 is one probe per page
  // load, never one per unlock and never one per focus — the mount already paid
  // it, and only a reload re-probes.
  if (featureDark) return Promise.resolve();
  const now = readClock(options);
  // 0 (never attempted) is trivially eligible — the arithmetic says so without
  // a special case.
  if (trigger === "focus" && now - lastAttemptStartedAt < FOCUS_DEBOUNCE_MS) {
    return Promise.resolve();
  }
  lastAttemptStartedAt = now;
  // Same capture rule as the mount path: the run belongs to the account that
  // committed it, however long the lane holds it.
  const generation = storeGeneration;
  return enqueueDrainWork(() =>
    drainConnectedConnectors(tcw, options, generation),
  ).catch(() => {
    // Quiet by contract: the record carries a "we don't know" entry, and the
    // lane is intact for the next attempt.
  });
}

// ── The record store ─────────────────────────────────────────────────
//
// `useSyncExternalStore`-shaped, mirroring the compaction-indicator store in
// `chatModelAdapter.ts`: a listener set, an equality-guarded write, and a
// subscribe that hands back its own disposer.

/**
 * The snapshot half of the `useSyncExternalStore` contract.
 *
 * REFERENTIALLY STABLE between real changes — every commit builds a NEW record
 * object and nothing ever mutates the held one, so repeated reads without an
 * intervening commit return the identical object. A store that rebuilt the
 * snapshot per read would spin React forever.
 */
export function readBackgroundDrainRecord(): BackgroundDrainRecord | null {
  return record;
}

/** The subscribe half. Returns the unsubscribe disposer. */
export function subscribeBackgroundDrainRecord(cb: () => void): () => void {
  recordListeners.add(cb);
  return () => {
    recordListeners.delete(cb);
  };
}

/**
 * The store generation an external publisher must capture WHEN ITS WORK
 * BEGINS (the Settings section captures it at mount) and hand back with each
 * publish. `clearBackgroundDrainRecord` advances it, which is what strands
 * every already-started publisher on the signed-out account's side of the
 * line. The headless run captures it internally at the moment its attempt is
 * committed.
 */
export function readBackgroundDrainGeneration(): number {
  return storeGeneration;
}

/** One listener's failure is not the drain's problem, nor the next listener's. */
function notifyRecordListeners(): void {
  for (const cb of [...recordListeners]) {
    try {
      cb();
    } catch {
      // Quiet by contract.
    }
  }
}

function sameConnectorRecord(
  a: BackgroundDrainConnectorRecord,
  b: BackgroundDrainConnectorRecord,
): boolean {
  return (
    a.source === b.source &&
    a.phase === b.phase &&
    a.pendingCount === b.pendingCount &&
    a.ingestBlocked === b.ingestBlocked &&
    a.surfaceBlocked === b.surfaceBlocked &&
    a.lastIngest === b.lastIngest
  );
}

/**
 * The ONE write path, and both of the record's honesty rules live in it.
 *
 * `generation` is the publisher's capture from when its work BEGAN. A stale
 * capture means the record was cleared while the work was in flight — the
 * account switched — and the commit is DROPPED: neither an unwinding drain run
 * nor a still-emitting Settings publish can resurrect the previous account's
 * counts.
 *
 * A `"replace"` commit is the headless run's: it enumerated every connector,
 * so its result set IS the record — an entry for a connector the run skipped
 * (disconnected, no longer available) drops out instead of pinning a stale
 * count. An `"upsert"` commit is a Settings publish: one source's fresh
 * numbers, merged in by `source`.
 *
 * Either way it notifies only when something actually changed — the guard is
 * what keeps a subscribed surface from re-rendering on every interim emit —
 * and the comparison is SOURCE-KEYED, so the same entries arriving in a
 * different order are not a change.
 */
function commitConnectorRecords(
  entries: readonly BackgroundDrainConnectorRecord[],
  generation: number,
  mode: "replace" | "upsert",
): void {
  if (generation !== storeGeneration) return;
  const current = record;
  let next: BackgroundDrainConnectorRecord[];
  if (mode === "replace") {
    next = [...entries];
  } else {
    next = current ? [...current.connectors] : [];
    for (const entry of entries) {
      const at = next.findIndex((e) => e.source === entry.source);
      if (at === -1) next.push(entry);
      else next[at] = entry;
    }
  }
  const unchanged =
    current !== null &&
    current.featureDark === featureDark &&
    current.connectors.length === next.length &&
    next.every((entry) => {
      const held = current.connectors.find((e) => e.source === entry.source);
      return held !== undefined && sameConnectorRecord(entry, held);
    });
  if (unchanged) return;
  record = { featureDark, connectors: next };
  notifyRecordListeners();
}

/**
 * Forget everything the record says — for sign-out, where the next user must
 * never inherit the previous one's counts. Deliberately clears ONLY the record:
 * the session latches are about this page load, not about who is signed in.
 */
export function clearBackgroundDrainRecord(): void {
  // Advance the generation FIRST, and unconditionally: in-flight work that
  // started before this clear must be stranded even when the record it would
  // have repopulated was still empty.
  storeGeneration += 1;
  if (record === null) return;
  record = null;
  notifyRecordListeners();
}

/**
 * Drop ONE connector's entry — the disconnect flow's half of pruning.
 *
 * A finished teardown removes the connector, but its record entry (typically
 * "enabled, N pending, vault locked") would otherwise keep the badge at N
 * until the next headless run — which may be a focus-tick away. The chat-side
 * disconnect orchestration calls this at teardown success, so the badge
 * settles with the teardown. Removing an entry that is not there is a silent
 * no-op.
 */
export function removeBackgroundDrainConnectorRecord(source: string): void {
  // Remove is a GENERATION BOUNDARY, exactly like the sign-out clear: an
  // in-flight run that started before the disconnect is stranded, so its
  // late replace-commit cannot resurrect the entry this just removed.
  storeGeneration += 1;
  if (record === null) return;
  const next = record.connectors.filter((entry) => entry.source !== source);
  if (next.length === record.connectors.length) return;
  record = { featureDark: record.featureDark, connectors: next };
  notifyRecordListeners();
}

/**
 * The shared derivation both publishers use, so the two paths can never
 * disagree about what a state means.
 *
 * `ingestBlocked` is derived rather than copied: the decision layer sets it
 * only after an ingest actually ran, so a locked count-only pass — the case a
 * count surface exists for — would otherwise carry `null`. "Locked vault, work
 * waiting, nothing processed" is precisely what `"secrets-locked"` means.
 */
export function deriveDrainConnectorRecord(
  source: string,
  state: BackgroundSyncState,
  secretsLocked: boolean,
): BackgroundDrainConnectorRecord {
  const pendingCount = state.queue?.pendingCount ?? null;
  return {
    source,
    phase: state.phase,
    pendingCount,
    ingestBlocked:
      state.ingestBlocked ??
      (secretsLocked && state.phase === "enabled" && (pendingCount ?? 0) > 0
        ? "secrets-locked"
        : null),
    surfaceBlocked: (state.queue?.blockedReason ?? null) !== null,
    lastIngest: state.lastIngest,
  };
}

/**
 * The Settings surface's publish seam.
 *
 * It already holds fresh numbers after every one of its runs, so this costs no
 * request — it just puts them where the headless record lives, which is what
 * stops a Settings sync from leaving a stale count behind. `loading` says
 * nothing either way, so a mounting section never clobbers a real record.
 */
export function publishBackgroundDrainConnectorState(
  source: string,
  state: BackgroundSyncState,
  secretsLocked: boolean,
  // The publisher's capture from when its work began (the section's mount).
  // Omitted means "captured now" — right for a caller whose read and publish
  // are one synchronous act, wrong for anything long-lived.
  generation: number = storeGeneration,
): void {
  if (state.phase === "loading") return;
  commitConnectorRecords(
    [deriveDrainConnectorRecord(source, state, secretsLocked)],
    generation,
    "upsert",
  );
}

// ── The badge's policy (pure, so the surface stays dumb) ─────────────

/**
 * How many meetings a count surface may honestly claim are waiting.
 *
 * Only "the vault is locked, work is queued, nothing was processed" counts.
 * Everything else renders NOTHING, deliberately:
 *
 *  - `"key-missing"` and the fail-closed surfacing gate are Settings' detail to
 *    explain, not a number to put in the header;
 *  - an unblocked leftover (`ingestBlocked: null` with items still pending)
 *    means an attempt RAN and items stayed queued — a failure, and failures
 *    stay quiet outside Settings;
 *  - dark, `unavailable`, and the catch-path "we don't know" entry say nothing
 *    either way, so the badge says nothing too.
 *
 * Silent on ambiguity is the rule: this returns counts, never errors.
 */
export function badgePendingCount(record: BackgroundDrainRecord | null): number {
  if (!record || record.featureDark) return 0;
  let total = 0;
  for (const entry of record.connectors) {
    if (entry.phase !== "enabled") continue;
    if (entry.ingestBlocked !== "secrets-locked") continue;
    if (entry.surfaceBlocked) continue;
    const pending = entry.pendingCount ?? 0;
    if (pending > 0) total += pending;
  }
  return total;
}

/**
 * The Settings button's accessible name, with the count folded in.
 *
 * Generic copy only — a provider name in the header would leak which service a
 * user connected to anyone reading the screen (or the accessibility tree). When
 * there is nothing to say the label is byte-identical to what it has always
 * been.
 */
export function settingsAriaLabel(showSettings: boolean, count: number): string {
  if (showSettings) return "Close settings";
  if (count <= 0) return "Settings";
  return `Settings — ${count} ${count === 1 ? "meeting" : "meetings"} waiting`;
}

/**
 * The pill's visible text. The pill is `aria-hidden` and the label carries the
 * exact number, so this clamp is purely a layout rule: a backend-supplied
 * count in the hundreds must not stretch a 16px pill across the header. Two
 * digits is the ceiling; past it the detail belongs in Settings, not the pill.
 */
export function badgePillLabel(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Tests only. Resets the attempt timestamp, the dark latch, the lane, the
 *  record and its subscribers — and advances the generation, so work leaking
 *  out of a previous test is stranded exactly like a signed-out account's. */
export function resetBackgroundDrainForTests(): void {
  lastAttemptStartedAt = 0;
  featureDark = false;
  drainLane = Promise.resolve();
  record = null;
  recordListeners.clear();
  storeGeneration += 1;
}

// ── The one run ──────────────────────────────────────────────────────

async function drainConnectedConnectors(
  tcw: TinyCloudWeb,
  options: BackgroundDrainOptions,
  /** The store generation captured when this run's attempt was committed —
   *  the run publishes as the account it started under, or not at all. */
  generation: number,
): Promise<void> {
  const { backendUrl, sessionStore } = options;
  const hooks = options.hooks ?? {};
  const connectors = hooks.connectors ?? CONNECTORS;
  const readConnection = hooks.getConnection ?? storeGetConnection;
  // The same typed client the card builds; constructing it performs no I/O.
  const webhooks =
    hooks.webhooks ?? createConnectorWebhooksClient(backendUrl, { sessionStore });

  const results: BackgroundDrainConnectorRecord[] = [];
  for (const descriptor of connectors) {
    // A dark route is dark for every connector — stop asking entirely.
    if (featureDark) break;
    if (descriptor.status !== "available") continue;
    try {
      // Connected-connector discovery is the card's own SQL read — it never
      // touches the vault. Not connected (or unreadable) → silently skip:
      // draining a queue this browser holds no key for would only burn the
      // deliveries' attempts.
      const connectionResult = await readConnection(tcw, descriptor.id);
      const connection = connectionResult.ok ? connectionResult.data : null;
      if (!supportsBackgroundNotifications(descriptor, connection)) continue;

      // The decision layer, verbatim: poll config; process automatically when
      // the vault is ALREADY open, otherwise only count. The emitted states go
      // into a local variable nobody renders.
      let state = initialBackgroundSyncState();
      const emit: BackgroundSyncEmit = (updater) => {
        state = updater(state);
      };
      await loadOnMount(buildHeadlessDrainDeps(tcw, descriptor, webhooks, hooks.ingest), emit);

      if (state.phase === "dark") featureDark = true;
      results.push(
        deriveDrainConnectorRecord(
          descriptor.source,
          state,
          // The same property read the headless deps use — never a prompt.
          !isSecretsUnlocked(tcw),
        ),
      );
    } catch {
      // The typed client resolves rather than throws, so this is defence in
      // depth: an unexpected failure is recorded as "we don't know" and the
      // app never hears about it.
      results.push({
        source: descriptor.source,
        phase: "unavailable",
        pendingCount: null,
        ingestBlocked: null,
        surfaceBlocked: false,
        lastIngest: null,
      });
    }
  }
  // ONE batch commit per run — and the run's only notification point. The run
  // enumerated every connector, so this REPLACES the entry set: whatever it
  // skipped (disconnected, no longer available) drops out rather than living
  // on as a stale count.
  commitConnectorRecords(results, generation, "replace");
}

/**
 * The headless `BackgroundSyncDeps`.
 *
 * Identical to the Settings section's wiring with ONE deliberate difference:
 * `unlock` is a hard-wired refusal. The headless surface has no user gesture,
 * so nothing it calls may reach the vault's unlock — not even by a future
 * refactor routing it through `syncQueuedMeetings`.
 */
export function buildHeadlessDrainDeps(
  tcw: TinyCloudWeb,
  descriptor: ConnectorDescriptor,
  webhooks: ConnectorWebhooksClient,
  ingest?: BackgroundDrainHooks["ingest"],
): BackgroundSyncDeps {
  return {
    source: descriptor.source,
    webhooks,
    secrets: {
      // A property read, never a prompt.
      isUnlocked: () => isSecretsUnlocked(tcw),
      unlock: async () => ({
        ok: false,
        error: { message: "The headless drain never unlocks. Unlock from Settings → Connectors." },
      }),
    },
    ingest: (items) =>
      ingest
        ? ingest(descriptor, items)
        : ingestQueuedMeetings({ tcw, descriptor, items, webhooks }),
  };
}

// ── React glue ───────────────────────────────────────────────────────

/** Fire-and-forget start on mount. The drain never gates rendering.
 *
 *  Also the registration seam for both re-arms:
 *
 *   - I2, a successful user-initiated unlock (from any of the four unlock
 *     sites — all funneled through the lib-side choke point);
 *   - I3, the window regaining focus, following App.tsx's "A1 trigger (c)"
 *     idiom exactly: a `window` focus listener added in an effect with
 *     symmetric cleanup, all gating pushed into the callee, event-driven with
 *     nothing left polling.
 *
 *  Both fire a re-armed run through the shared lane. Registration is
 *  effect-time (never module-load — that would leak across test files) so an
 *  unmount / sign-out cleanly unhooks it, and every listener carries the
 *  latest options via the effect's closure. The listeners exist only while the
 *  drainer is mounted, which the app shell gates on being signed in — so the
 *  effect's existence IS the signed-in check and its cleanup IS the sign-out
 *  teardown. */
export function useBackgroundDrain(options: BackgroundDrainOptions): void {
  const { tcw, sessionStore, backendUrl, hooks } = options;
  useEffect(() => {
    const current = { tcw, sessionStore, backendUrl, hooks };
    void maybeStartBackgroundDrain(current);
    if (!tcw) return;
    const off = onSecretsUnlocked(() => {
      void resumeBackgroundDrain(current, "unlock");
    });
    const onFocus = () => {
      void resumeBackgroundDrain(current, "focus");
    };
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [tcw, sessionStore, backendUrl, hooks]);
}

/**
 * The app-shell mount point. Renders NOTHING in every state — the Settings
 * surface stays the only place background-notification detail lives.
 */
export function BackgroundDrainer(props: BackgroundDrainOptions): null {
  useBackgroundDrain(props);
  return null;
}
