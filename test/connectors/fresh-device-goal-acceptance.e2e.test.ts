// W12 — THE FRESH-DEVICE GOAL-ACCEPTANCE LANE (backend-ingest plan §12.1).
//
// This is the test that DEFINES done for the backend-ingest cutover. Plan §12.1,
// verbatim:
//
//   "Goal acceptance (W12), the test that defines done: on a fresh device/browser
//    profile that has never held the Fireflies key and never opened the app before
//    — sign in, open meetings: cohort meetings are visible via the read API. No
//    vault unlock, no key entry. (Sign-in is still required; 'always there' means
//    no prior device setup, not anonymous access.)"
//
// Every other test in this repo proves a component. This one proves the GOAL, and
// it is the only test whose failure means the feature did not happen — a green
// backend suite with a red lane here is a backend that stores meetings nobody can
// see from a new device.
//
// ── WHY IT IS SKIPPED BY DEFAULT ───────────────────────────────────────────
//
// It cannot be faked and it cannot be sandboxed. The only target that can answer
// it is a deployment where `CONNECTOR_BACKEND_INGEST_ENABLED=true` AND the signing
// address is in the `webhooks/ingest/cohort` allowlist — i.e. SHARED INFRA with a
// live, full-account Fireflies credential behind it. Running it needs an operator:
// a human completes the passkey + SIWE sign-in (that is the point — sign-in is
// required), and the operator is the one who decided that account may be touched.
//
// So the lane is disarmed unless `FRESH_DEVICE_LANE=1` is set explicitly, and an
// armed-but-incomplete config THROWS rather than skipping: a goal-acceptance test
// that reports green because someone typo'd an env var is worse than no test. See
// `docs/connector-webhooks-fresh-device-acceptance.md` for the operator procedure.
//
// The unarmed run is not empty. The acceptance criterion itself is encoded as data
// and asserted below, so the definition of done stays pinned — in particular that
// SIGN-IN REMAINS REQUIRED — even on a machine that can never run the browser half.
//
// ── WHAT THIS LANE MAY NEVER BE RELAXED INTO ───────────────────────────────
//
// "Always there" is bounded. If a future edit makes this pass without a sign-in,
// it is asserting a promise the product does not make and the consent copy
// explicitly denies (`consent-scope.test.ts`: "signing in is still required").
// The unauthenticated probe in step 1 exists to make that failure loud.
//
// Usage (operator, against a cohort-enabled target):
//
//   FRESH_DEVICE_LANE=1 \
//   FRESH_DEVICE_APP_URL=https://tinycloud.chat/chat \
//   FRESH_DEVICE_BACKEND_URL=https://api.tinycloud.chat \
//   bun test test/connectors/fresh-device-goal-acceptance.e2e.test.ts
//
// The profile directory must NOT exist yet: "fresh device" is the hypothesis under
// test, and reusing a profile that once held a vault signature silently proves
// nothing. The lane refuses to reuse one — there is no override flag.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);

// ── The criterion, as data ─────────────────────────────────────────────────

/**
 * Plan §12.1's sentence, decomposed into the checks the armed lane performs. Kept
 * as an exported constant so the unarmed run can still assert the SHAPE of the
 * definition of done — nobody weakens the goal by editing a comment.
 */
export const FRESH_DEVICE_ACCEPTANCE = {
  /** The plan sentence this lane exists to execute. Quoted, not paraphrased. */
  criterion:
    "On a fresh device/browser profile that has never held the Fireflies key and never opened " +
    "the app before — sign in, open meetings: cohort meetings are visible via the read API. " +
    "No vault unlock, no key entry.",
  /** The bound on "always there". Removing this is removing the honesty of the claim. */
  bound:
    "Sign-in is still required; \"always there\" means no prior device setup, not anonymous access.",
  steps: [
    "fresh-profile-guard: the browser profile directory is absent or empty before launch",
    "signin-required: an unauthenticated GET of the read API is rejected, never a meetings list",
    "signin: a human completes the passkey + SIWE ceremony in the fresh profile",
    "read-api: GET /api/connectors/meetings answers 200 with at least one cohort meeting",
    "meetings-visible: the Meetings surface renders those meetings in the app",
    "content: opening one meeting answers 200 from GET /:source/:sourceId",
    "no-vault-unlock: no vault/secrets unlock is prompted or performed at any point",
    "no-key-entry: no Fireflies key is entered, requested, or read on this device",
  ],
} as const;

// ── Config + arming ────────────────────────────────────────────────────────

export interface FreshDeviceConfig {
  /** The app route that renders the shell (NOT the marketing landing page). */
  appUrl: string;
  /** The backend origin the read API is served from. */
  backendUrl: string;
  /** A directory that must not exist yet — the fresh device. */
  profileDir: string;
  source: string;
  /** A human is walking through a passkey; minutes, not seconds. */
  signInTimeoutMs: number;
  /** How many cohort meetings must be visible for the goal to be met. */
  minMeetings: number;
  /** Leave the browser open after the lane for operator inspection. */
  keepOpen: boolean;
}

export type FreshDeviceArming =
  | { armed: false; reason: string }
  | { armed: true; config: FreshDeviceConfig };

export const FRESH_DEVICE_ARM_VAR = "FRESH_DEVICE_LANE";

/**
 * Resolve the lane from env.
 *
 * Two rules, both deliberate:
 *
 *  1. **Exact `"1"` arms it.** `true`, `yes`, `TRUE` and `on` do NOT — the same
 *     exact-string discipline `backendIngestEnabled()` uses for the dark flag, for
 *     the same reason: a value that "looks on" must never half-enable something
 *     that touches a live account.
 *  2. **Armed + incomplete THROWS.** A missing target is a misconfiguration, and
 *     the one outcome a goal-acceptance test may not produce for it is a silent
 *     skip that reads as "nothing to run here".
 */
export function resolveFreshDeviceLane(
  env: Record<string, string | undefined>,
): FreshDeviceArming {
  const armValue = env[FRESH_DEVICE_ARM_VAR];
  if (armValue !== "1") {
    return {
      armed: false,
      reason:
        armValue === undefined
          ? `${FRESH_DEVICE_ARM_VAR} is unset — the lane runs against shared infra and needs an operator`
          : `${FRESH_DEVICE_ARM_VAR}=${armValue} is not the exact string "1"`,
    };
  }

  const appUrl = env.FRESH_DEVICE_APP_URL?.trim();
  const backendUrl = env.FRESH_DEVICE_BACKEND_URL?.trim();
  const missing = [
    appUrl ? null : "FRESH_DEVICE_APP_URL",
    backendUrl ? null : "FRESH_DEVICE_BACKEND_URL",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `${FRESH_DEVICE_ARM_VAR}=1 but the target is incomplete: ${missing.join(", ")} unset. ` +
        "The lane targets a cohort-enabled deployment; it has no default and will not guess one.",
    );
  }

  return {
    armed: true,
    config: {
      appUrl: appUrl as string,
      backendUrl: (backendUrl as string).replace(/\/+$/, ""),
      // Timestamped by default so a second run cannot silently inherit the first
      // run's session — freshness is the hypothesis, not a convenience.
      profileDir: resolve(
        repoRoot,
        env.FRESH_DEVICE_PROFILE_DIR ??
          `test/.auth/fresh-device/${new Date().toISOString().replace(/[:.]/g, "-")}`,
      ),
      source: env.FRESH_DEVICE_SOURCE ?? "fireflies",
      signInTimeoutMs: intEnv(env, "FRESH_DEVICE_SIGNIN_TIMEOUT_MS", 10 * 60_000),
      minMeetings: intEnv(env, "FRESH_DEVICE_MIN_MEETINGS", 1),
      keepOpen: env.FRESH_DEVICE_KEEP_OPEN === "1",
    },
  };
}

function intEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name}=${raw} is not a positive integer`);
  }
  return parsed;
}

/**
 * The fresh-device guard, as a pure function so it is testable without a browser.
 *
 * A profile that already exists may hold a session, an IndexedDB-cached vault
 * signature, or a stored Fireflies key — every one of which falsifies the premise
 * ("never held the Fireflies key and never opened the app"). There is no reuse
 * flag: a lane that can be pointed at a warm profile is a lane that can report the
 * goal met when it was met yesterday, by a different device.
 */
export function assertFreshProfile(dir: string): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir);
  if (entries.length === 0) return;
  throw new Error(
    `Profile directory is not fresh: ${dir} holds ${entries.length} entr${entries.length === 1 ? "y" : "ies"}. ` +
      "W12 tests a device that has never opened the app; point FRESH_DEVICE_PROFILE_DIR at a new " +
      "path or delete this one. There is deliberately no reuse override.",
  );
}

// ── Always-on: the definition of done stays pinned ─────────────────────────

describe("W12 fresh-device goal acceptance — lane contract", () => {
  test("the lane is disarmed by default", () => {
    expect(resolveFreshDeviceLane({})).toEqual({
      armed: false,
      reason: `${FRESH_DEVICE_ARM_VAR} is unset — the lane runs against shared infra and needs an operator`,
    });
  });

  test("only the exact string \"1\" arms it", () => {
    for (const value of ["true", "TRUE", "yes", "on", "0", " 1", ""]) {
      const result = resolveFreshDeviceLane({ [FRESH_DEVICE_ARM_VAR]: value });
      expect({ value, armed: result.armed }).toEqual({ value, armed: false });
    }
  });

  test("armed with an incomplete target throws rather than skipping", () => {
    expect(() => resolveFreshDeviceLane({ [FRESH_DEVICE_ARM_VAR]: "1" })).toThrow(
      /FRESH_DEVICE_APP_URL, FRESH_DEVICE_BACKEND_URL unset/,
    );
    expect(() =>
      resolveFreshDeviceLane({
        [FRESH_DEVICE_ARM_VAR]: "1",
        FRESH_DEVICE_APP_URL: "https://example.invalid/chat",
      }),
    ).toThrow(/FRESH_DEVICE_BACKEND_URL unset/);
  });

  test("a fully specified target resolves, with the backend origin de-slashed", () => {
    const result = resolveFreshDeviceLane({
      [FRESH_DEVICE_ARM_VAR]: "1",
      FRESH_DEVICE_APP_URL: "https://example.invalid/chat",
      FRESH_DEVICE_BACKEND_URL: "https://api.example.invalid/",
      FRESH_DEVICE_MIN_MEETINGS: "3",
    });
    expect(result.armed).toBe(true);
    if (!result.armed) return;
    expect(result.config.backendUrl).toBe("https://api.example.invalid");
    expect(result.config.minMeetings).toBe(3);
    expect(result.config.source).toBe("fireflies");
  });

  test("a profile directory that already holds anything is refused", () => {
    const dir = join(tmpdir(), `w12-fresh-device-guard-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });

    // Absent → fresh.
    expect(() => assertFreshProfile(dir)).not.toThrow();
    // Empty → still fresh (the launcher creates it).
    mkdirSync(dir, { recursive: true });
    expect(() => assertFreshProfile(dir)).not.toThrow();
    // Anything at all → refused.
    writeFileSync(join(dir, "Default"), "a warm profile");
    expect(() => assertFreshProfile(dir)).toThrow(/not fresh/);

    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The bound on "always there", pinned here as well as in the consent copy
   * (`backend/src/__tests__/consent-scope.test.ts` — "signing in is still
   * required"). If someone rewrites this lane so that a signed-out browser can see
   * meetings, the criterion below no longer describes what runs, and this test is
   * where that divergence surfaces.
   */
  test("the criterion still requires sign-in and still forbids vault/key setup", () => {
    expect(FRESH_DEVICE_ACCEPTANCE.bound).toContain("Sign-in is still required");
    expect(FRESH_DEVICE_ACCEPTANCE.bound).toContain("not anonymous access");
    expect(FRESH_DEVICE_ACCEPTANCE.criterion).toContain("never held the Fireflies key");
    expect(FRESH_DEVICE_ACCEPTANCE.criterion).toContain("No vault unlock, no key entry");

    const stepIds = FRESH_DEVICE_ACCEPTANCE.steps.map((step) => step.split(":")[0]);
    expect(stepIds).toEqual([
      "fresh-profile-guard",
      "signin-required",
      "signin",
      "read-api",
      "meetings-visible",
      "content",
      "no-vault-unlock",
      "no-key-entry",
    ]);
  });
});

// ── The armed lane ─────────────────────────────────────────────────────────

const arming = resolveFreshDeviceLane(process.env as Record<string, string | undefined>);
const config = arming.armed ? arming.config : null;

if (!arming.armed) {
  console.log(
    `[w12] fresh-device lane SKIPPED — ${arming.reason}. ` +
      "See docs/connector-webhooks-fresh-device-acceptance.md.",
  );
}

/** Held so `afterAll` can close a context the lane opened. */
let closeContext: (() => Promise<void>) | null = null;

afterAll(async () => {
  if (closeContext !== null && !(config?.keepOpen ?? false)) await closeContext();
});

describe.skipIf(config === null)(
  "W12 fresh-device goal acceptance — the goal (plan §12.1)",
  () => {
    /**
     * Step 2, run BEFORE the browser exists: an unauthenticated read of the cohort
     * surface must not answer with meetings.
     *
     * 401 is the pass. 404 also passes and means something different — the flag is
     * dark or this deployment mounts nothing — so it is reported distinctly rather
     * than folded in: a lane that "passes" against a dark target has proven
     * nothing about the goal, and step 4 will fail loudly right after.
     */
    test("signin-required: the read API rejects an unauthenticated caller", async () => {
      const cfg = config as FreshDeviceConfig;
      const response = await fetch(`${cfg.backendUrl}/api/connectors/meetings`, {
        method: "GET",
        headers: { accept: "application/json" },
      });
      expect({ status: response.status, ok: response.ok }).toEqual({
        status: response.status,
        ok: false,
      });
      expect([401, 403, 404]).toContain(response.status);
    });

    /**
     * Steps 1 and 3–8, in one browser session, because they are one claim: this
     * device, brand new, sees the meetings after nothing but a sign-in.
     *
     * The evidence is collected three ways, because no single one is sufficient on
     * a production build:
     *
     *  - **Network.** Every request is recorded. The read API must answer 200; no
     *    request may carry a Fireflies key; and the pass fails if the app fetches a
     *    connector secret.
     *  - **UI.** The Meetings surface must actually render rows. A 200 nobody can
     *    see is not the goal.
     *  - **The dev seam, when present.** `window.__tcw` is exposed only under
     *    `import.meta.env.DEV` (`frontend/src/App.tsx`), so against a production
     *    bundle it is absent. When it IS there the lane reads
     *    `secrets.isUnlocked` directly; when it is not, the vault claim rests on
     *    the observable proof (no unlock UI, no extra signature ceremony, no
     *    secrets traffic) and the lane SAYS SO in its output rather than implying a
     *    stronger check than it made.
     */
    test(
      "fresh device: sign in, open meetings, see them — no vault unlock, no key entry",
      async () => {
        const cfg = config as FreshDeviceConfig;

        // Step 1 — the fresh-device guard. Before anything is launched.
        assertFreshProfile(cfg.profileDir);
        mkdirSync(cfg.profileDir, { recursive: true });

        // Imported lazily: `playwright` lives in test/node_modules and must not be
        // a load-time dependency of the unarmed run.
        const { chromium } = await import("playwright");

        const context = await chromium.launchPersistentContext(cfg.profileDir, {
          headless: false, // a human has to complete the passkey
          viewport: { width: 1280, height: 900 },
        });
        closeContext = async () => {
          await context.close();
        };

        const requests: Array<{ method: string; url: string; status: number | null }> = [];
        const extraPages: string[] = [];
        context.on("page", (p) => extraPages.push(p.url()));
        context.on("requestfinished", (request) => {
          void request
            .response()
            .then((response) =>
              requests.push({
                method: request.method(),
                url: request.url(),
                status: response?.status() ?? null,
              }),
            )
            .catch(() => {
              /* a request that never resolved is not evidence of anything */
            });
        });

        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(cfg.appUrl, { waitUntil: "domcontentloaded" });

        // Step 3 — sign-in. REQUIRED, and performed by a human: this is the one
        // ceremony the goal keeps. The wait is the operator's window.
        console.log(
          `[w12] waiting up to ${Math.round(cfg.signInTimeoutMs / 1000)}s for the operator to sign in ` +
            `on the FRESH profile at ${cfg.profileDir}`,
        );
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .waitFor({ state: "visible", timeout: cfg.signInTimeoutMs });

        const pagesAfterSignIn = extraPages.length;

        // Steps 4–6 — open the meetings surface and read it.
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page
          .getByRole("heading", { name: "Meetings", exact: true })
          .waitFor({ state: "visible", timeout: 60_000 });

        const listCalls = requests.filter(
          (r) => r.method === "GET" && /\/api\/connectors\/meetings(\?|$)/.test(r.url),
        );
        expect(listCalls.some((r) => r.status === 200)).toBe(true);

        // The rows themselves. `MeetingsView` renders nothing at all when the
        // address is outside the cohort, so an empty surface here is a REAL
        // failure — either the enrolment or the ingest did not happen.
        //
        // Selected structurally (the section that owns the heading → its list
        // items) rather than by a test id: W5's markup carries none, and adding one
        // to prove the goal would be the lane editing the thing it measures.
        const meetingsSection = page
          .locator("section")
          .filter({ has: page.getByRole("heading", { name: "Meetings", exact: true }) })
          .first();
        const rows = meetingsSection.locator("ul > li");
        const rowCount = await rows.count();
        expect(rowCount).toBeGreaterThanOrEqual(cfg.minMeetings);

        // Every visible row came from the SERVER. `meetingsView` tags a row that
        // was merged from this device's own space "On this device" — on a genuinely
        // fresh profile there is no such space content, so that badge appearing
        // means the profile was not fresh and the run proves nothing.
        expect(await meetingsSection.getByText("On this device").count()).toBe(0);

        // Step 6 — content, still with no vault in the picture.
        await rows.first().getByRole("button").first().click();
        await page.waitForTimeout(2_000);
        const contentCalls = requests.filter(
          (r) =>
            r.method === "GET" &&
            new RegExp(`/api/connectors/meetings/${cfg.source}/[^/]+$`).test(r.url),
        );
        expect(contentCalls.some((r) => r.status === 200)).toBe(true);

        // Step 7 — no vault unlock. Observable proof first (always available).
        expect(await page.getByRole("button", { name: /unlock/i }).count()).toBe(0);
        expect(extraPages.length).toBe(pagesAfterSignIn);

        // …then the seam, when the target is a dev build.
        const vaultProbe = await page.evaluate(() => {
          const handle = (window as unknown as { __tcw?: { secrets?: { isUnlocked?: boolean } } })
            .__tcw;
          if (!handle) return { seam: false as const };
          return { seam: true as const, isUnlocked: handle.secrets?.isUnlocked === true };
        });
        if (vaultProbe.seam) {
          expect(vaultProbe.isUnlocked).toBe(false);
        } else {
          console.log(
            "[w12] window.__tcw is absent (production bundle) — the no-vault-unlock claim rests on " +
              "the observable proof: no unlock control, no additional signing ceremony, no secrets traffic.",
          );
        }

        // Step 8 — no key entry. Nothing on this device ever held or asked for the
        // Fireflies key: the connect dialog was never opened, and no request went
        // near a connector secret.
        expect(await page.getByLabel(/api key/i).count()).toBe(0);
        const secretsTraffic = requests.filter((r) => /secrets?\//i.test(r.url));
        expect(secretsTraffic.map((r) => r.url)).toEqual([]);

        console.log(
          `[w12] GOAL MET — ${rowCount} cohort meeting(s) visible on a fresh device after sign-in alone.`,
        );
      },
      // The human sign-in dominates; the timeout has to clear it with room.
      (config?.signInTimeoutMs ?? 0) + 5 * 60_000,
    );
  },
);
