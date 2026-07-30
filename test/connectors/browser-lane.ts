// Browser-e2e lane for the Connectors feature — the real UI, the real TinyCloud
// space, and the in-repo mock Fireflies upstream. See docs/connectors-spec.md §10.
//
// What this proves that the bun drivers cannot: the settings page opens with no
// wallet prompt, the connect stepper drives the real sync engine, and the data
// that lands is in the user's actual space (SQL rows, KV bodies, encrypted
// secrets) rather than a fake. Assertions read storage through the dev-only
// `window.__tcw` handle App.tsx exposes under `import.meta.env.DEV`.
//
// Auth is the one thing that cannot be faked: the Connectors card only renders
// behind a live `tcw`, and sign-in is an OpenKey passkey plus a SIWE signature.
// So the lane uses a PERSISTENT Chrome profile. The first run stops at the
// sign-in wall and waits for a human; every run after that restores the session
// (and the IndexedDB-cached vault signature) and runs start to finish untouched.
//
// Usage:
//   bun run test:connectors:browser              # full lane
//   bun run test:connectors:browser --cors-check # mixed-content/CORS probe only
//
// Env overrides: CONNECTORS_LANE_{MOCK_PORT,VITE_PORT,BACKEND_URL,PROFILE_DIR,
// SIGNIN_TIMEOUT_MS,SYNC_TIMEOUT_MS,KEEP_OPEN}.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

import {
  extractStoredSession,
  resolveRealAuthCommandEnv,
  type PlaywrightStorageState,
} from "../real-auth-support.ts";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const env = resolveRealAuthCommandEnv({ cwd: repoRoot, env: process.env });

const corsCheckOnly = process.argv.includes("--cors-check");
// Forces the sign-in ceremony even when the profile holds a live session. Use
// when a session predates a manifest change: capabilities are baked in at
// sign-in, so a stale session keeps the old (narrower) grants forever.
const freshSession = process.argv.includes("--fresh-session");

/** Thrown when the profile has no session and no human completed the ceremony. */
class SignInWallError extends Error {}

const config = {
  mockPort: intEnv("CONNECTORS_LANE_MOCK_PORT", 4801),
  vitePort: intEnv("CONNECTORS_LANE_VITE_PORT", 5199),
  sharedBackendUrl: env.CONNECTORS_LANE_BACKEND_URL ?? "https://localhost:3014",
  // Only used when the shared dev backend is absent or pinned to a different
  // frontend origin (its CORS allowlist is a single URL).
  ownBackendPort: intEnv("CONNECTORS_LANE_BACKEND_PORT", 3015),
  profileDir: resolve(
    repoRoot,
    env.CONNECTORS_LANE_PROFILE_DIR ?? "test/.auth/connectors-profile",
  ),
  // Generous by default — a human has to walk through a passkey. The dry run
  // shortens it so it can prove the wall is reached without a person present.
  signInTimeoutMs: intEnv("CONNECTORS_LANE_SIGNIN_TIMEOUT_MS", 10 * 60 * 1000),
  // The initial sync writes 30 SQL rows + 30 KV bodies through the real node,
  // one at a time (TinyCloud drops concurrent responses). Minutes, not seconds.
  syncTimeoutMs: intEnv("CONNECTORS_LANE_SYNC_TIMEOUT_MS", 15 * 60 * 1000),
  keepOpen: env.CONNECTORS_LANE_KEEP_OPEN === "1",
};

const frontendUrl = `https://localhost:${config.vitePort}`;
// `/` is the marketing landing page; the app (and its Settings route) is /chat.
const appUrl = `${frontendUrl}/chat`;
const mockUrl = `http://127.0.0.1:${config.mockPort}/graphql`;

// A junk key: the mock's happy mode accepts any non-empty bearer, and using an
// obviously fake value makes the "this string never reaches KV or SQL" leak scan
// unambiguous.
const LANE_API_KEY = "mock-key-browser-lane";

const APP_ID = "xyz.tinycloud.tinychat";
// SQL db names AND KV keys are both sent verbatim as the invoke path and must
// carry the full app-id prefix the manifest resolved the grant to. See the
// RESOURCE PATH CONVENTION note in connectorStore.ts.
const CONNECTORS_DB = `${APP_ID}/connectors`;
const SOURCE = "fireflies";
const TRANSCRIPT_KV_PREFIX = `${APP_ID}/connectors/${SOURCE}/transcript/`;
const SEED_COUNT = 30;
const EXPECTED_IDS = Array.from(
  { length: SEED_COUNT },
  (_, i) => `mock-tx-${String(i + 1).padStart(3, "0")}`,
);
const SAMPLE_IDS = ["mock-tx-001", "mock-tx-015", "mock-tx-030"];

const evidenceDir = join(
  repoRoot,
  "test/.auth/evidence",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

/**
 * The slice of `tcw` the lane reaches through the dev probe seam. Declared once
 * so the reset and the probe agree on the shape they are calling.
 */
interface TcwProbe {
  sql: {
    db: (name: string) => {
      query: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ ok: boolean; data?: { rows: unknown[][] }; error?: { message?: string } }>;
      execute: (
        sql: string,
        params?: unknown[],
      ) => Promise<{ ok: boolean; error?: { message?: string } }>;
    };
  };
  kv: {
    get: (key: string) => Promise<{ ok: boolean; data?: { data?: unknown } }>;
    delete: (key: string) => Promise<{ ok: boolean }>;
    list: (opts: { path?: string }) => Promise<{ ok: boolean; data?: { keys?: string[] } }>;
  };
  secrets: {
    isUnlocked: boolean;
    unlock: () => Promise<{ ok: boolean; error?: { message?: string } }>;
    get: (
      name: string,
      opts: { scope: string },
    ) => Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }>;
    delete: (name: string, opts: { scope: string }) => Promise<{ ok: boolean }>;
  };
}

const consoleLog: string[] = [];
let shotSeq = 0;
// Held so the top-level failure handler can capture the screen at the moment
// things broke — a stack trace without the frame is half the evidence.
let activePage: Page | null = null;

// ── Entry ──────────────────────────────────────────────────────────────────

const cleanups: Array<() => Promise<void> | void> = [];

try {
  mkdirSync(evidenceDir, { recursive: true });
  log(`evidence → ${evidenceDir}`);

  await startMock();
  const backendUrl = await ensureBackend();
  await startVite(backendUrl);

  if (corsCheckOnly) {
    await runCorsCheck();
  } else {
    await runLane();
  }
  await teardown();
  process.exit(0);
} catch (error) {
  console.error("");
  console.error(`LANE FAILED: ${errorMessage(error)}`);
  if (activePage) await shot(activePage, "FAILURE");
  if (consoleLog.length > 0) {
    console.error("");
    console.error("--- last browser console messages ---");
    for (const line of consoleLog.slice(-40)) console.error(`  ${line}`);
    console.error("--- end console ---");
  }
  await teardown();
  // 2 = "never got past the sign-in wall" (expected on a fresh profile with no
  // human present); 1 = a real assertion or infrastructure failure.
  process.exit(error instanceof SignInWallError ? 2 : 1);
}

// ── Lane ───────────────────────────────────────────────────────────────────

async function runLane(): Promise<void> {
  const context = await launchContext();
  const page = context.pages()[0] ?? (await context.newPage());
  wirePageLogging(page);

  // Any wallet/permission ceremony surfaces as a new page (popup) or a new
  // cross-origin frame; both are watched from before the first navigation.
  const popups: string[] = [];
  context.on("page", (p) => popups.push(p.url()));

  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  if (freshSession) await clearStoredSession(page);
  await waitForSignedIn(context, page);
  await shot(page, "app-ready");
  await assertSeamLive(page);

  const framesBefore = new Set(page.frames().map((f) => f.url()));
  const popupsBefore = popups.length;

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Fireflies" })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await shot(page, "settings-open-connectors-visible");

  assertNoCeremony(page, framesBefore, popups, popupsBefore, "opening settings");
  log("settings opened with no wallet popup and no new cross-origin frame");

  // The lane must be repeatable against a space that a previous run already
  // wrote to, so start from a known-clean connector: purge through the product's
  // own store/secrets modules, then reload so the card re-reads its state.
  await resetConnectorState(page);

  // ── Connect ──
  const initialAdded = await connectFireflies(page, "initial");
  await shot(page, "initial-sync-done");
  expect(
    initialAdded === SEED_COUNT,
    `initial sync must report ${SEED_COUNT} added, reported ${initialAdded}`,
  );

  const afterInitial = await probeStorage(page);
  reportProbe("after initial sync", afterInitial);
  expect(
    afterInitial.sqlCount === SEED_COUNT,
    `SQL connector_meeting rows: expected ${SEED_COUNT}, got ${afterInitial.sqlCount}`,
  );
  expect(
    afterInitial.kvCount === SEED_COUNT,
    `KV transcript bodies: expected ${SEED_COUNT}, got ${afterInitial.kvCount} (via ${afterInitial.kvCountMethod})`,
  );
  expect(
    afterInitial.secretMatches,
    "the API key must be readable back from encrypted secrets",
  );
  expect(
    !afterInitial.keyInSql,
    "the API key must NEVER appear in a SQL connector_meeting row",
  );
  expect(
    !afterInitial.keyInKv,
    "the API key must NEVER appear in a KV transcript body",
  );

  // ── Idempotent re-sync ──
  await page.getByRole("button", { name: "Sync Fireflies now" }).click();
  await waitForSyncIdle(page);
  await shot(page, "sync-now-done");

  const afterResync = await probeStorage(page);
  reportProbe("after second sync", afterResync);
  expect(
    afterResync.sqlCount === SEED_COUNT,
    `second sync must add 0 rows: expected ${SEED_COUNT}, got ${afterResync.sqlCount}`,
  );
  expect(
    afterResync.kvCount === SEED_COUNT,
    `second sync must add 0 KV bodies: expected ${SEED_COUNT}, got ${afterResync.kvCount}`,
  );

  // ── Disconnect, keep data ──
  await disconnect(page, { purge: false });
  await shot(page, "disconnected-data-kept");

  const afterKeep = await probeStorage(page);
  reportProbe("after disconnect (keep)", afterKeep);
  expect(
    afterKeep.sqlCount === SEED_COUNT,
    `disconnect without purge must keep rows: expected ${SEED_COUNT}, got ${afterKeep.sqlCount}`,
  );
  expect(
    afterKeep.kvCount === SEED_COUNT,
    `disconnect without purge must keep KV bodies: expected ${SEED_COUNT}, got ${afterKeep.kvCount}`,
  );

  // ── Reconnect, then disconnect WITH purge ──
  // The kept data makes this an early-exit sync: the transcripts are already
  // known, so nothing new should be added.
  const reconnectAdded = await connectFireflies(page, "reconnect");
  await shot(page, "reconnected");
  expect(
    reconnectAdded === 0,
    `reconnect sync must add 0 (data was kept), reported ${reconnectAdded}`,
  );

  await disconnect(page, { purge: true });
  await shot(page, "disconnected-purged");

  const afterPurge = await probeStorage(page);
  reportProbe("after disconnect (purge)", afterPurge);
  expect(
    afterPurge.sqlCount === 0,
    `purge must delete every row: expected 0, got ${afterPurge.sqlCount}`,
  );
  expect(
    afterPurge.kvCount === 0,
    `purge must delete every KV body: expected 0, got ${afterPurge.kvCount}`,
  );

  console.log("");
  console.log("✅ Connectors browser lane passed against real space storage.");
}

/**
 * Setup, not assertion: wipe any connector residue left by an earlier run so the
 * lane's counts mean what they say. Uses the product's own purge + secret-delete
 * through the dev seam, then reloads to force the card to re-read SQL.
 */
async function resetConnectorState(page: Page): Promise<void> {
  // Driven one call at a time from here rather than as one opaque evaluate, so a
  // slow or stalled TinyCloud round trip names itself instead of hanging the lane.
  const ids = await evalStep(
    page,
    "reset: list synced ids",
    async (args: { dbName: string; source: string }) => {
      const tcw = (window as unknown as { __tcw?: TcwProbe }).__tcw;
      if (!tcw) throw new Error("window.__tcw is not exposed");
      const res = await tcw.sql
        .db(args.dbName)
        .query("SELECT source_id FROM connector_meeting WHERE source = ?", [args.source]);
      if (!res.ok) return [] as string[];
      return (res.data?.rows ?? [])
        .map((r) => r[0])
        .filter((v): v is string => typeof v === "string");
    },
    { dbName: CONNECTORS_DB, source: SOURCE },
  );
  log(`reset: ${ids.length} meeting rows to clear`);

  for (const [i, sid] of ids.entries()) {
    await evalStep(
      page,
      `reset: kv delete ${i + 1}/${ids.length}`,
      async (key: string) => {
        const tcw = (window as unknown as { __tcw?: TcwProbe }).__tcw;
        if (!tcw) throw new Error("window.__tcw is not exposed");
        return (await tcw.kv.delete(key)).ok;
      },
      `${TRANSCRIPT_KV_PREFIX}${sid}`,
      { quiet: true },
    );
  }

  await evalStep(
    page,
    "reset: clear sql rows",
    async (args: { dbName: string; source: string }) => {
      const tcw = (window as unknown as { __tcw?: TcwProbe }).__tcw;
      if (!tcw) throw new Error("window.__tcw is not exposed");
      const db = tcw.sql.db(args.dbName);
      await db.execute("DELETE FROM connector_meeting WHERE source = ?", [args.source]);
      await db.execute("DELETE FROM connector_state WHERE connector_id = ?", [args.source]);
      return true;
    },
    { dbName: CONNECTORS_DB, source: SOURCE },
  );

  const secretCleared = await evalStep(
    page,
    "reset: clear secret",
    async (args: { source: string; secretName: string }) => {
      const tcw = (window as unknown as { __tcw?: TcwProbe }).__tcw;
      if (!tcw) throw new Error("window.__tcw is not exposed");
      // `secrets.delete` on a key that does not exist has been observed to never
      // settle, so each secrets call gets its own in-page deadline; a stuck reset
      // must degrade into a reported string, not a wedged lane.
      const raceTimeout = <T,>(p: Promise<T>, ms: number, what: string) =>
        Promise.race([
          p,
          new Promise<string>((r) => setTimeout(() => r(`${what}:TIMED_OUT`), ms)),
        ]);
      if (!tcw.secrets.isUnlocked) {
        const unlock = await raceTimeout(tcw.secrets.unlock(), 30_000, "unlock");
        if (typeof unlock === "string") return unlock;
        if (!unlock.ok) return `unlock failed: ${unlock.error?.message ?? "unknown"}`;
      }
      // A missing key is the normal case on a clean space, not a failure.
      const del = await raceTimeout(
        tcw.secrets.delete(args.secretName, { scope: args.source }),
        30_000,
        "delete",
      );
      if (typeof del === "string") return del;
      return del.ok ? "deleted" : "absent";
    },
    { source: SOURCE, secretName: "API_KEY" },
  );
  log(`reset: cleared ${ids.length} kv bodies, secret ${secretCleared}`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Connect Fireflies", exact: true })
    .waitFor({ state: "visible", timeout: 60_000 });
}

/**
 * Fail fast if the env seam is not actually live in the page. Without this the
 * lane's first symptom would be a 401 that looks like a bad key, when the real
 * cause is the UI still pointing at the production Fireflies endpoint.
 */
async function assertSeamLive(page: Page): Promise<void> {
  const resolved = (await page.evaluate(async () => {
    const mod = await import("/src/lib/connectors/firefliesClient.ts");
    return mod.defaultFirefliesClientOptions();
  })) as { apiUrl: string; delayMs: number };
  log(`client defaults resolved in the page: ${JSON.stringify(resolved)}`);
  expect(
    resolved.apiUrl === mockUrl,
    `VITE_FIREFLIES_API_URL seam is not live — the page resolves apiUrl=${resolved.apiUrl}, expected ${mockUrl}`,
  );
}

/** Drives the connect stepper end to end; returns the added-count the dialog reports. */
async function connectFireflies(page: Page, label: string): Promise<number> {
  log(`connect (${label}): opening dialog`);
  await page.getByRole("button", { name: "Connect Fireflies", exact: true }).click();
  const keyInput = page.locator("#fireflies-api-key");
  await keyInput.waitFor({ state: "visible", timeout: 30_000 });
  await keyInput.fill(LANE_API_KEY);
  await shot(page, `${label}-key-entered`);

  await page.getByRole("button", { name: "Continue" }).click();
  try {
    await page
      .getByText("Verified with Fireflies")
      .waitFor({ state: "visible", timeout: 60_000 });
  } catch {
    const upstreams = consoleLog.filter((l) => l.startsWith("[upstream]"));
    const inlineError = await page.locator("[role=alert]").allInnerTexts().catch(() => []);
    throw new Error(
      `key validation never verified. UI said: ${inlineError.join(" | ") || "(nothing)"}. ` +
        `Upstream requests seen: ${upstreams.join(" | ") || "(none)"}`,
    );
  }
  await shot(page, `${label}-verified`);
  log(`connect (${label}): key verified against the mock upstream`);

  await page.getByRole("button", { name: "Save & sync" }).click();
  // The dialog settles on either the done panel ("N meetings synced.") or the
  // "connected, but the initial sync failed" panel. Waiting on the summary text
  // rather than the footer button both avoids the dialog's own aria-label="Close"
  // X and yields the added-count the evidence bar is written against.
  const settled = page.getByText(
    /\d+ meetings? synced\.|Connected, but the initial sync failed/,
  );
  await settled.first().waitFor({ state: "visible", timeout: config.syncTimeoutMs });
  // Per-item sync errors live in a collapsed <details>; open it so the summary
  // text and the screenshot both carry the reason rather than just the count.
  await page.evaluate(() => {
    document
      .querySelectorAll<HTMLDetailsElement>("[role=dialog] details")
      .forEach((d) => (d.open = true));
  });
  await shot(page, `${label}-sync-finished`);

  const summaryText = await page.locator("[role=dialog]").innerText();
  if (summaryText.includes("Connected, but the initial sync failed")) {
    throw new Error(`sync failed in the UI: ${summaryText.replace(/\s+/g, " ").trim()}`);
  }
  const added = Number.parseInt(summaryText.match(/(\d+) meetings? synced\./)?.[1] ?? "-1", 10);
  log(`connect (${label}): dialog reports added=${added}`);
  if (summaryText.includes("failed to sync")) {
    log(`connect (${label}) sync errors: ${summaryText.replace(/\s+/g, " ").trim()}`);
  }

  // Escape rather than a Close click — same reason as above.
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Sync Fireflies now" })
    .waitFor({ state: "visible", timeout: 60_000 });
  return added;
}

async function disconnect(page: Page, opts: { purge: boolean }): Promise<void> {
  log(`disconnect (purge=${opts.purge})`);
  await page.getByRole("button", { name: "Disconnect Fireflies" }).click();
  const confirmName = opts.purge ? "Disconnect & delete data" : "Disconnect";
  const confirmDialog = page.getByRole("alertdialog");
  await confirmDialog.waitFor({ state: "visible", timeout: 30_000 });
  if (opts.purge) {
    await confirmDialog.getByRole("checkbox").check();
  }
  await shot(page, `disconnect-confirm-purge-${opts.purge}`);
  await confirmDialog.getByRole("button", { name: confirmName, exact: true }).click();
  // The card flips back to "Connect" once the dialog settles.
  await page
    .getByRole("button", { name: "Connect Fireflies", exact: true })
    .waitFor({ state: "visible", timeout: 120_000 });
}

/** Wait until the card's Sync button is no longer in its syncing state. */
async function waitForSyncIdle(page: Page): Promise<void> {
  const syncButton = page.getByRole("button", { name: "Sync Fireflies now" });
  await syncButton.waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.getAttribute("aria-label") === "Sync Fireflies now",
      );
      return !!btn && !btn.hasAttribute("disabled");
    },
    undefined,
    { timeout: config.syncTimeoutMs },
  );
}

// ── Storage probe (through the dev-only window.__tcw seam) ─────────────────

interface StorageProbe {
  sqlCount: number;
  kvCount: number;
  kvCountMethod: "list" | "per-id";
  sampledKvPresent: Record<string, boolean>;
  secretMatches: boolean;
  keyInSql: boolean;
  keyInKv: boolean;
  notes: string[];
}

async function probeStorage(page: Page): Promise<StorageProbe> {
  const result = await withTimeout(
    page.evaluate(
    async (args) => {
      const tcw = (window as unknown as { __tcw?: TcwProbe }).__tcw;
      if (!tcw) throw new Error("window.__tcw is not exposed — is vite running in DEV mode?");

      const notes: string[] = [];
      const db = tcw.sql.db(args.dbName);

      // Every call below is sequential on purpose: TinyCloud drops concurrent
      // responses on the same space.
      const rowsRes = await db.query(
        "SELECT id, source, source_id, title, participants, metadata FROM connector_meeting WHERE source = ?",
        [args.source],
      );
      const rows = rowsRes.ok ? (rowsRes.data?.rows ?? []) : [];
      if (!rowsRes.ok) notes.push(`SQL query failed: ${rowsRes.error?.message ?? "unknown"}`);
      const sqlCount = rows.length;
      const keyInSql = JSON.stringify(rows).includes(args.apiKey);

      let kvCount = 0;
      let kvCountMethod: "list" | "per-id" = "list";
      const listRes = await tcw.kv.list({ path: args.kvPrefix });
      if (listRes.ok && Array.isArray(listRes.data?.keys)) {
        kvCount = listRes.data.keys.filter((k) => k.includes(args.kvPrefix)).length;
      } else {
        // The session's capabilities may not include tinycloud.kv/list; fall
        // back to probing each expected id so the count stays real evidence.
        kvCountMethod = "per-id";
        notes.push("kv.list unavailable — counted by probing each expected id");
        for (const id of args.expectedIds) {
          const got = await tcw.kv.get(`${args.kvPrefix}${id}`);
          if (got.ok) kvCount++;
        }
      }

      const sampledKvPresent: Record<string, boolean> = {};
      let keyInKv = false;
      for (const id of args.sampleIds) {
        const got = await tcw.kv.get(`${args.kvPrefix}${id}`);
        sampledKvPresent[id] = got.ok;
        if (got.ok && JSON.stringify(got.data?.data ?? null).includes(args.apiKey)) {
          keyInKv = true;
        }
      }

      if (!tcw.secrets.isUnlocked) {
        const unlock = await tcw.secrets.unlock();
        if (!unlock.ok) notes.push(`secrets unlock failed: ${unlock.error?.message ?? "unknown"}`);
      }
      const secret = await tcw.secrets.get(args.secretName, { scope: args.secretScope });
      const secretMatches = secret.ok && secret.data === args.apiKey;
      // A bare `secretReadBack=false` is undiagnosable — say whether the read
      // failed (and why) or succeeded with a value that does not match.
      if (!secretMatches) {
        notes.push(
          secret.ok
            ? "secret read back a value that does not match the key the UI submitted"
            : `secret read failed: [${secret.error?.code ?? "?"}] ${secret.error?.message ?? "unknown"}`,
        );
      }

      return {
        sqlCount,
        kvCount,
        kvCountMethod,
        sampledKvPresent,
        secretMatches,
        keyInSql,
        keyInKv,
        notes,
      };
    },
    {
      dbName: CONNECTORS_DB,
      source: SOURCE,
      apiKey: LANE_API_KEY,
      kvPrefix: TRANSCRIPT_KV_PREFIX,
      expectedIds: EXPECTED_IDS,
      sampleIds: SAMPLE_IDS,
        secretName: "API_KEY",
        secretScope: SOURCE,
      },
    ),
    config.syncTimeoutMs,
    "storage probe",
  );
  return result as StorageProbe;
}

function reportProbe(label: string, probe: StorageProbe): void {
  log(
    `probe ${label}: sql=${probe.sqlCount} kv=${probe.kvCount} (${probe.kvCountMethod}) ` +
      `secretReadBack=${probe.secretMatches} keyInSql=${probe.keyInSql} keyInKv=${probe.keyInKv}`,
  );
  for (const note of probe.notes) log(`  note: ${note}`);
}

// ── CORS / mixed-content probe ─────────────────────────────────────────────

/**
 * Answers the one question the design could not settle on paper: will Chrome
 * let an https dev-server page POST JSON with an Authorization header to
 * http://127.0.0.1? Loopback is "potentially trustworthy" per the mixed-content
 * spec, but that is only worth believing after a real browser says so.
 */
async function runCorsCheck(): Promise<void> {
  const context = await launchContext();
  const page = context.pages()[0] ?? (await context.newPage());
  wirePageLogging(page);
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });

  const verdict = await page.evaluate(async (url) => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer cors-probe",
        },
        body: JSON.stringify({ query: "query GetUser { user { name email } }" }),
      });
      const body = await res.text();
      return { ok: true as const, status: res.status, body: body.slice(0, 200) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, mockUrl);

  await shot(page, "cors-check");
  console.log("");
  console.log(`CORS/mixed-content probe: page ${frontendUrl} → ${mockUrl}`);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.ok) {
    throw new Error(
      `Chrome blocked the cross-origin request from an https page to loopback http: ${verdict.error}`,
    );
  }
  console.log("Verdict: allowed — plain-http loopback upstream is reachable from the https page.");
}

// ── Sign-in wall ───────────────────────────────────────────────────────────

/**
 * Resume keylessly when the profile already holds a live session; otherwise
 * click "Sign in" and wait for a human to finish the passkey + SIWE ceremony.
 */
async function waitForSignedIn(context: BrowserContext, page: Page): Promise<void> {
  if (await hasLiveSession(context)) {
    log("restoring the profile's existing session (no sign-in ceremony needed)");
  } else {
    // The header and the empty state both offer "Sign in"; either opens the
    // same OpenKey flow, so nudge the first and say so if the nudge missed.
    await page
      .getByRole("button", { name: "Sign in" })
      .first()
      .click({ timeout: 10_000 })
      .then(() => log("clicked Sign in for you"))
      .catch((err) => log(`could not click Sign in (${errorMessage(err)}) — please click it`));
    await shot(page, "sign-in-wall");
    console.log("");
    console.log("=".repeat(72));
    console.log("SIGN-IN REQUIRED — this profile has no live session.");
    console.log("In the Chrome window that just opened:");
    console.log('  1. Click "Sign in" and complete the OpenKey passkey.');
    console.log("  2. Approve the TinyCloud signature / space creation if prompted.");
    console.log("The lane resumes automatically and this profile stays signed in");
    console.log("for every later run, so this is a one-time cost.");
    console.log(`Profile: ${config.profileDir}`);
    console.log("=".repeat(72));
    console.log("");
  }

  const deadline = Date.now() + config.signInTimeoutMs;
  while (Date.now() < deadline) {
    // The session token proves the backend handshake; __tcw proves the app
    // finished booting into its ready state with a live space session.
    if (await hasLiveSession(context)) {
      const ready = await page
        .evaluate(() => Boolean((window as unknown as { __tcw?: unknown }).__tcw))
        .catch(() => false);
      if (ready) return;
    }
    await page.waitForTimeout(1_000);
  }
  await shot(page, "sign-in-timeout");
  throw new SignInWallError(
    `no live session after ${Math.round(config.signInTimeoutMs / 1000)}s at the sign-in wall`,
  );
}

/** Drop the persisted session so the next load lands on the sign-in wall. */
async function clearStoredSession(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.localStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const db of dbs) {
      if (db.name) indexedDB.deleteDatabase(db.name);
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  log("--fresh-session: cleared the stored session, forcing a new sign-in");
}

async function hasLiveSession(context: BrowserContext): Promise<boolean> {
  const state = (await context.storageState()) as PlaywrightStorageState;
  const session = extractStoredSession(state);
  return Boolean(session && session.expiresAt > Date.now() + 30_000);
}

// ── Ceremony assertion ─────────────────────────────────────────────────────

function assertNoCeremony(
  page: Page,
  framesBefore: Set<string>,
  popups: string[],
  popupsBefore: number,
  what: string,
): void {
  const newPopups = popups.slice(popupsBefore);
  expect(
    newPopups.length === 0,
    `${what} must not open a wallet/permission popup (saw: ${newPopups.join(", ")})`,
  );
  const appOrigin = new URL(frontendUrl).origin;
  const newForeignFrames = page
    .frames()
    .map((f) => f.url())
    .filter(
      (url) =>
        !framesBefore.has(url) &&
        /^https?:/.test(url) &&
        new URL(url).origin !== appOrigin,
    );
  expect(
    newForeignFrames.length === 0,
    `${what} must not mount a cross-origin auth frame (saw: ${newForeignFrames.join(", ")})`,
  );
}

// ── Browser ────────────────────────────────────────────────────────────────

async function launchContext(): Promise<BrowserContext> {
  mkdirSync(config.profileDir, { recursive: true });
  log(`launching Chrome with profile ${config.profileDir}`);
  const context = await chromium.launchPersistentContext(config.profileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    // The vite dev cert is mkcert-issued and trusted in the system keychain;
    // this only covers the case where a lane runs on a machine without it.
    ignoreHTTPSErrors: true,
  });
  cleanups.push(async () => {
    if (config.keepOpen) {
      log("CONNECTORS_LANE_KEEP_OPEN=1 — leaving the browser open");
      return;
    }
    await context.close().catch(() => {});
  });
  return context;
}

function wirePageLogging(page: Page): void {
  activePage = page;
  // Which upstream the client actually talked to is the first thing you want to
  // know when a key "fails to validate" — the seam pointing at the real
  // Fireflies endpoint and the mock rejecting a key look identical in the UI.
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("fireflies") || url.includes(`:${config.mockPort}`)) {
      const line = `[upstream] ${req.method()} ${url}`;
      consoleLog.push(line);
      log(line);
    }
  });
  page.on("console", (msg) => {
    const line = `[${msg.type()}] ${msg.text()}`;
    consoleLog.push(line);
    if (msg.type() === "error") console.log(`  [browser console.error] ${msg.text()}`);
  });
  page.on("pageerror", (err) => {
    consoleLog.push(`[pageerror] ${err.message}`);
    console.log(`  [pageerror] ${err.message}`);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  shotSeq += 1;
  const file = join(evidenceDir, `${String(shotSeq).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch((err) => {
    log(`screenshot ${name} failed: ${errorMessage(err)}`);
  });
  log(`screenshot → ${file}`);
}

// ── Processes ──────────────────────────────────────────────────────────────

async function startMock(): Promise<void> {
  const proc = Bun.spawn(["bun", join(repoRoot, "test/connectors/mock-fireflies.mjs")], {
    cwd: repoRoot,
    env: { ...env, MOCK_FIREFLIES_PORT: String(config.mockPort), MOCK_FIREFLIES_MODE: "happy" },
    stdout: "inherit",
    stderr: "inherit",
  });
  cleanups.push(() => {
    proc.kill();
  });
  await waitForHttp(mockUrl, "mock upstream", async () => {
    // A bare OPTIONS is the cheapest liveness probe now that preflight is handled.
    const res = await fetch(mockUrl, { method: "OPTIONS" });
    return res.status === 204;
  });
}

async function startVite(backendUrl: string): Promise<void> {
  const proc = Bun.spawn(
    [
      join(repoRoot, "frontend/node_modules/.bin/vite"),
      "--port",
      String(config.vitePort),
      "--strictPort",
    ],
    {
      cwd: join(repoRoot, "frontend"),
      env: {
        ...env,
        VITE_FIREFLIES_API_URL: mockUrl,
        VITE_FIREFLIES_DELAY_MS: "0",
        VITE_BACKEND_URL: backendUrl,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  cleanups.push(() => {
    proc.kill();
  });
  log(`vite starting on ${frontendUrl} with VITE_FIREFLIES_API_URL=${mockUrl}`);
  await waitForHttp(frontendUrl, "vite dev server", async () => {
    const res = await fetch(frontendUrl, { tls: { rejectUnauthorized: false } } as RequestInit);
    return res.ok;
  });
}

/**
 * Reuse the shared dev backend when it is up AND its CORS allowlist names our
 * frontend origin — that allowlist is a single URL (`cors({ origin: FRONTEND_URL })`),
 * so a backend started for the default :5186 dev server would reject every call
 * from the lane's port. Otherwise run a private backend pinned to our origin.
 */
async function ensureBackend(): Promise<string> {
  if (await backendUsable(config.sharedBackendUrl)) {
    log(`reusing the backend already running at ${config.sharedBackendUrl}`);
    return config.sharedBackendUrl;
  }
  const ownUrl = `https://localhost:${config.ownBackendPort}`;
  log(
    `no backend at ${config.sharedBackendUrl} serving ${frontendUrl} — starting one at ${ownUrl}`,
  );
  const proc = Bun.spawn(["bun", "src/index.ts"], {
    cwd: join(repoRoot, "backend"),
    // Explicit env wins over backend/.env in Bun, so these pin the private
    // instance to the lane's port and origin without touching the .env file.
    env: { ...env, PORT: String(config.ownBackendPort), FRONTEND_URL: frontendUrl },
    stdout: "inherit",
    stderr: "inherit",
  });
  cleanups.push(() => {
    proc.kill();
  });
  await waitForHttp(ownUrl, "backend", () => backendUsable(ownUrl));
  return ownUrl;
}

async function backendUsable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/health`, {
      headers: { Origin: frontendUrl },
      tls: { rejectUnauthorized: false },
    } as RequestInit);
    return res.ok && res.headers.get("access-control-allow-origin") === frontendUrl;
  } catch {
    return false;
  }
}

async function waitForHttp(
  url: string,
  label: string,
  probe: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      if (await probe()) {
        log(`${label} ready at ${url}`);
        return;
      }
      lastError = "probe returned false";
    } catch (err) {
      lastError = errorMessage(err);
    }
    await Bun.sleep(500);
  }
  throw new Error(`${label} never became ready at ${url} (last error: ${lastError})`);
}

async function teardown(): Promise<void> {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // Teardown is best-effort — a failing cleanup must not mask the result.
    }
  }
}

// ── Small helpers ──────────────────────────────────────────────────────────

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

/** One bounded, timed round trip into the page. Reports how long it took. */
async function evalStep<A, R>(
  page: Page,
  label: string,
  fn: (arg: A) => Promise<R>,
  arg: A,
  opts: { quiet?: boolean; timeoutMs?: number } = {},
): Promise<R> {
  const started = Date.now();
  const result = await withTimeout(
    page.evaluate(fn, arg),
    opts.timeoutMs ?? 120_000,
    label,
  );
  const elapsed = Date.now() - started;
  // Per-item chatter is only worth printing when it is slow enough to matter.
  if (!opts.quiet || elapsed > 5_000) log(`${label} — ${elapsed}ms`);
  return result;
}

/**
 * `page.evaluate` has no timeout of its own, and these evaluates make dozens of
 * sequential round trips to a real node — one stalled call would hang the lane
 * forever with no evidence. Bound them.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function intEnv(name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function log(message: string): void {
  console.log(`[lane] ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
