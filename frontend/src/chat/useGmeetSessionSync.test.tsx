// Contract for the once-per-session Google Meet sync trigger (plan §6 WP-B).
//
// The non-negotiables under test:
//
//   1. DARK IS A NO-OP — while the registry row is `coming-soon` (the entire
//      dark phase, and today's shipped state) the hook reads no connection, no
//      secret, mints no token and runs no sync, for every user;
//   2. once per session — a second trigger short-circuits on the latch;
//   3. a locked vault DEFERS silently: no throw, no prompt, no burned attempt,
//      and the next unlock retries;
//   4. abort on unmount — the mount's signal threads into the sync engine, and
//      an aborted signal stops the run before it starts;
//   5. failures stay contained — a rejecting or failing sync never propagates;
//   6. no credential material is ever logged, and the drainer's lane is not
//      touched.
//
// Logic-level throughout, no DOM harness (repo convention): fakes over the
// injected seams, and source assertions for component plumbing that cannot be
// exercised inside a bun test process — the idiom
// `useBackgroundDrain.test.tsx` / `ConnectorsCard.test.ts` established.

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  GMEET_CONNECTOR_ID,
  GOOGLE_OAUTH_REFRESH_PATH,
  GmeetSessionSync,
  hasGmeetSessionSyncRun,
  maybeStartGmeetSessionSync,
  mintGmeetAccessToken,
  resetGmeetSessionSyncForTests,
  type GmeetSessionSyncHooks,
  type GmeetSessionSyncOptions,
} from "./useGmeetSessionSync";
import { CONNECTORS } from "@/lib/connectors/registry";
import { GmeetClient } from "@/lib/connectors/gmeetClient";
import type {
  GmeetSyncOptions,
  GmeetSyncResult,
  GmeetSyncSummary,
} from "@/lib/connectors/gmeetSync";
import type { ConnectorConnection, ConnectorDescriptor } from "@/lib/connectors/types";

// ── Fixtures ─────────────────────────────────────────────────────────

const BACKEND = "https://backend.example";
/** Obviously fake — no real credential material lives in this repo. */
const REFRESH_TOKEN = "test-refresh-token";
const ACCESS_TOKEN = "test-access-token";

const SESSION = {
  getToken: () => "session-token",
  isExpired: () => false,
  clear: () => {},
} as unknown as SessionStore;

/** The registry row, whatever its current status — read to prove the lane's id
 *  and the registry's agree, never to assert a status. The two rows below are
 *  what the behavioural tests drive, so this suite's verdicts do not move when
 *  the flip commit changes the shipped row. */
const shippedGmeetRow = CONNECTORS.find((c) => c.id === GMEET_CONNECTOR_ID)!;

/** The row BEFORE the flip — the dark phase, pinned as a fixture rather than
 *  read from the registry so the dark-safety verdicts stay assertable after the
 *  registry no longer supplies a `coming-soon` google-meet row. */
const comingSoonGmeetRow: ConnectorDescriptor = {
  ...shippedGmeetRow,
  status: "coming-soon",
  secretName: "API_KEY",
};

/** The row as it looks AFTER the flip — the only way this suite can exercise
 *  the connected path without touching the registry. */
const availableGmeetRow: ConnectorDescriptor = {
  ...shippedGmeetRow,
  status: "available",
  secretName: "REFRESH_TOKEN",
};

function connection(patch: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    connectorId: GMEET_CONNECTOR_ID,
    status: "connected",
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    itemCount: 0,
    ...patch,
  };
}

function syncOk(patch: Partial<GmeetSyncSummary> = {}) {
  return {
    ok: true as const,
    data: {
      windowStartIso: "2026-07-18T00:00:00.000Z",
      windowEndIso: "2026-08-17T00:00:00.000Z",
      total: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      aborted: false,
      items: [],
      ...patch,
    },
  } satisfies GmeetSyncResult;
}

/**
 * A vault whose reads are COUNTED. `secrets.isUnlocked` is the property the
 * production gate reads; `get` is what a real `getConnectorKey` calls, so a
 * test that expects "zero secret reads" is checking the real path.
 */
function vault(options: { unlocked: boolean; token?: string | null }) {
  let getCalls = 0;
  const tcw = {
    secrets: {
      isUnlocked: options.unlocked,
      get: async () => {
        getCalls++;
        const token = options.token === undefined ? REFRESH_TOKEN : options.token;
        return token === null
          ? { ok: false, error: { code: "NOT_FOUND", message: "no secret" } }
          : { ok: true, data: token };
      },
    },
  } as unknown as TinyCloudWeb;
  return { tcw, getCalls: () => getCalls };
}

interface Harness {
  options: GmeetSessionSyncOptions;
  tcw: TinyCloudWeb;
  secretReads: () => number;
  connectionReads: () => number;
  mints: () => number;
  syncs: () => GmeetSyncOptions[];
}

/** The connected, unlocked, available happy path — every seam counted. */
function harness(
  overrides: {
    unlocked?: boolean;
    token?: string | null;
    connection?: ConnectorConnection | null;
    connectors?: readonly ConnectorDescriptor[];
    accessToken?: string | null;
    syncResult?: GmeetSyncResult | (() => Promise<GmeetSyncResult>);
    signal?: AbortSignal;
    hooks?: Partial<GmeetSessionSyncHooks>;
  } = {},
): Harness {
  const v = vault({ unlocked: overrides.unlocked ?? true, token: overrides.token });
  let connectionReads = 0;
  let mints = 0;
  const syncs: GmeetSyncOptions[] = [];

  const hooks: GmeetSessionSyncHooks = {
    connectors: overrides.connectors ?? [availableGmeetRow],
    getConnection: async () => {
      connectionReads++;
      const conn =
        overrides.connection === undefined ? connection() : overrides.connection;
      return { ok: true, data: conn };
    },
    mintAccessToken: async () => {
      mints++;
      return overrides.accessToken === undefined ? ACCESS_TOKEN : overrides.accessToken;
    },
    createClient: () => ({}) as never,
    runSync: async (opts) => {
      syncs.push(opts);
      const result = overrides.syncResult ?? syncOk();
      return typeof result === "function" ? await result() : result;
    },
    ...overrides.hooks,
  };

  return {
    options: {
      tcw: v.tcw,
      sessionStore: SESSION,
      backendUrl: BACKEND,
      signal: overrides.signal,
      hooks,
    },
    tcw: v.tcw,
    secretReads: v.getCalls,
    connectionReads: () => connectionReads,
    mints: () => mints,
    syncs: () => syncs,
  };
}

beforeEach(() => {
  resetGmeetSessionSyncForTests();
});

// ── 1. DARK-SAFETY (the whole dark phase) ────────────────────────────

describe("dark safety", () => {
  test("the registry carries a google-meet row for this lane to key off", () => {
    // Deliberately NOT an assertion about its status: the flip commit changes
    // that, and a suite that pinned today's value would have to move with it.
    // The dark-safety VERDICTS below are driven by `comingSoonGmeetRow`.
    expect(shippedGmeetRow.id).toBe(GMEET_CONNECTOR_ID);
    expect(shippedGmeetRow.source).toBe("google-meet");
  });

  test("an unavailable row means zero sync attempts and zero secret reads", async () => {
    const h = harness({ connectors: [comingSoonGmeetRow] });
    const outcome = await maybeStartGmeetSessionSync(h.options);
    expect(outcome).toBe("unavailable");
    expect(h.connectionReads()).toBe(0);
    expect(h.secretReads()).toBe(0);
    expect(h.mints()).toBe(0);
    expect(h.syncs()).toHaveLength(0);
    // And the session's one attempt is untouched.
    expect(hasGmeetSessionSyncRun()).toBe(false);
  });

  test("a registry with no google-meet row at all is the same no-op", async () => {
    const h = harness({ connectors: [] });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("unavailable");
    expect(h.syncs()).toHaveLength(0);
  });
});

// ── 2. Once per session ──────────────────────────────────────────────

describe("once per session", () => {
  test("the happy path runs the sync exactly once", async () => {
    const h = harness();
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("synced");
    expect(h.syncs()).toHaveLength(1);
    expect(hasGmeetSessionSyncRun()).toBe(true);

    expect(await maybeStartGmeetSessionSync(h.options)).toBe("already-ran");
    expect(h.syncs()).toHaveLength(1);
    expect(h.secretReads()).toBe(1);
    expect(h.mints()).toBe(1);
  });

  test("two triggers arriving together JOIN one run — one secret read, one sync", async () => {
    const h = harness();
    const [a, b] = await Promise.all([
      maybeStartGmeetSessionSync(h.options),
      maybeStartGmeetSessionSync(h.options),
    ]);
    expect(a).toBe("synced");
    expect(b).toBe("synced");
    expect(h.syncs()).toHaveLength(1);
    expect(h.secretReads()).toBe(1);
    expect(h.mints()).toBe(1);
  });

  test("signed out is a free no-op that does not burn the attempt", async () => {
    const h = harness();
    const outcome = await maybeStartGmeetSessionSync({ ...h.options, tcw: null });
    expect(outcome).toBe("signed-out");
    expect(hasGmeetSessionSyncRun()).toBe(false);
    expect(h.syncs()).toHaveLength(0);
  });

  test("a connector that is not connected reads no secret and burns nothing", async () => {
    const h = harness({ connection: null });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("not-connected");
    expect(h.secretReads()).toBe(0);
    expect(h.syncs()).toHaveLength(0);
    expect(hasGmeetSessionSyncRun()).toBe(false);
  });

  test("a disconnected row is treated as not connected", async () => {
    const h = harness({ connection: connection({ status: "disconnected" }) });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("not-connected");
    expect(h.syncs()).toHaveLength(0);
  });
});

// ── 3. Locked vault: defer silently, stay retriable ──────────────────

describe("locked vault", () => {
  test("defers with no throw, no secret read, no request, no burned attempt", async () => {
    const h = harness({ unlocked: false });
    const outcome = await maybeStartGmeetSessionSync(h.options);
    expect(outcome).toBe("vault-locked");
    expect(h.secretReads()).toBe(0);
    expect(h.mints()).toBe(0);
    expect(h.syncs()).toHaveLength(0);
    expect(hasGmeetSessionSyncRun()).toBe(false);
  });

  test("the deferral is retriable — the next unlock runs the sync", async () => {
    const locked = harness({ unlocked: false });
    expect(await maybeStartGmeetSessionSync(locked.options)).toBe("vault-locked");

    // The same session, after the user unlocked: the latch was never burned.
    const unlocked = harness({ unlocked: true });
    expect(await maybeStartGmeetSessionSync(unlocked.options)).toBe("synced");
    expect(unlocked.syncs()).toHaveLength(1);
  });

  test("the module never reaches for the interactive unlock helper", () => {
    const source = readFileSync(join(import.meta.dir, "useGmeetSessionSync.ts"), "utf8");
    expect(source).not.toContain("unlockSecrets");
  });
});

// ── 4. Abort ─────────────────────────────────────────────────────────

describe("abort", () => {
  test("an already-aborted signal stops before any credential is read", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ signal: controller.signal });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("aborted");
    expect(h.secretReads()).toBe(0);
    expect(h.syncs()).toHaveLength(0);
  });

  test("the mount's signal is threaded into the sync engine", async () => {
    const controller = new AbortController();
    const h = harness({ signal: controller.signal });
    await maybeStartGmeetSessionSync(h.options);
    expect(h.syncs()[0]?.signal).toBe(controller.signal);
    // Aborting after the run started is visible to the engine's own checks.
    controller.abort();
    expect(h.syncs()[0]?.signal?.aborted).toBe(true);
  });

  test("an aborted run reports `aborted`, not a failure", async () => {
    const h = harness({ syncResult: syncOk({ aborted: true }) });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("aborted");
  });

  test("an abort landing between the mint and the client is honoured", async () => {
    const controller = new AbortController();
    const h = harness({
      signal: controller.signal,
      hooks: {
        mintAccessToken: async () => {
          controller.abort();
          return ACCESS_TOKEN;
        },
      },
    });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("aborted");
    expect(h.syncs()).toHaveLength(0);
  });
});

// ── 5. Failures stay contained ───────────────────────────────────────

describe("failures never propagate", () => {
  test("a failing sync resolves to `sync-error` instead of throwing", async () => {
    const h = harness({
      syncResult: {
        ok: false,
        error: { kind: "network", message: "Google is unreachable" },
        data: null,
      },
    });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("sync-error");
  });

  test("a REJECTING sync is caught — App never sees it", async () => {
    const h = harness({
      syncResult: () => Promise.reject(new Error("boom")),
    });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("sync-error");
  });

  test("a throwing connection read is contained", async () => {
    const h = harness({
      hooks: {
        getConnection: () => {
          throw new Error("space unreachable");
        },
      },
    });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("sync-error");
    expect(h.syncs()).toHaveLength(0);
  });

  test("a missing refresh token stops quietly after burning the attempt", async () => {
    const h = harness({ token: null });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("no-refresh-token");
    expect(h.mints()).toBe(0);
    expect(h.syncs()).toHaveLength(0);
    // A vault that holds no token will not grow one this session.
    expect(hasGmeetSessionSyncRun()).toBe(true);
  });

  test("a token that cannot be minted stops before the engine", async () => {
    const h = harness({ accessToken: null });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("token-unavailable");
    expect(h.syncs()).toHaveLength(0);
  });
});

// ── The access-token mint (the WP-A proxy) ───────────────────────────

describe("mintGmeetAccessToken", () => {
  function fetchStub(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return await handler(url, init);
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("POSTs the refresh token to the authed proxy and returns the access token", async () => {
    const stub = fetchStub(
      () => new Response(JSON.stringify({ access_token: ACCESS_TOKEN, expires_in: 3599 }), { status: 200 }),
    );
    const token = await mintGmeetAccessToken({
      backendUrl: BACKEND,
      sessionStore: SESSION,
      refreshToken: REFRESH_TOKEN,
      fetchImpl: stub.impl,
    });
    expect(token).toBe(ACCESS_TOKEN);
    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0]!;
    expect(call.url).toBe(`${BACKEND}${GOOGLE_OAUTH_REFRESH_PATH}`);
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer session-token");
    // CSRF: the same header the house clients send on unsafe methods.
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(JSON.parse(String(call.init.body))).toEqual({ refreshToken: REFRESH_TOKEN });
  });

  test("a dark route (404), an invalid_grant (400) and a 5xx all resolve to null", async () => {
    for (const status of [404, 400, 401, 503]) {
      const stub = fetchStub(() => new Response(JSON.stringify({ error: "nope" }), { status }));
      expect(
        await mintGmeetAccessToken({
          backendUrl: BACKEND,
          sessionStore: SESSION,
          refreshToken: REFRESH_TOKEN,
          fetchImpl: stub.impl,
        }),
      ).toBeNull();
    }
  });

  test("a transport failure and malformed JSON resolve to null, never a throw", async () => {
    const boom = fetchStub(() => {
      throw new Error("offline");
    });
    expect(
      await mintGmeetAccessToken({
        backendUrl: BACKEND,
        sessionStore: SESSION,
        refreshToken: REFRESH_TOKEN,
        fetchImpl: boom.impl,
      }),
    ).toBeNull();

    const garbage = fetchStub(() => new Response("not json", { status: 200 }));
    expect(
      await mintGmeetAccessToken({
        backendUrl: BACKEND,
        sessionStore: SESSION,
        refreshToken: REFRESH_TOKEN,
        fetchImpl: garbage.impl,
      }),
    ).toBeNull();
  });

  test("a signed-out session sends no request at all", async () => {
    const stub = fetchStub(() => new Response("{}", { status: 200 }));
    const signedOut = {
      getToken: () => null,
      isExpired: () => false,
      clear: () => {},
    } as unknown as SessionStore;
    expect(
      await mintGmeetAccessToken({
        backendUrl: BACKEND,
        sessionStore: signedOut,
        refreshToken: REFRESH_TOKEN,
        fetchImpl: stub.impl,
      }),
    ).toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

// ── The default client ───────────────────────────────────────────────

describe("default client", () => {
  test("the minted token builds a real GmeetClient handed to the engine", async () => {
    const h = harness({ hooks: { createClient: undefined } });
    expect(await maybeStartGmeetSessionSync(h.options)).toBe("synced");
    expect(h.syncs()[0]?.client).toBeInstanceOf(GmeetClient);
  });
});

// ── 6. Quiet by contract + wiring ────────────────────────────────────

describe("quiet by contract", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");
  const source = read("useGmeetSessionSync.ts");

  test("nothing louder than a debug breadcrumb, and no credential interpolation", () => {
    expect(source).not.toContain("console.log(");
    expect(source).not.toContain("console.warn(");
    expect(source).not.toContain("console.error(");
    // No token, code or Google message body may ever reach a log line.
    expect(source).not.toContain("${refreshToken}");
    expect(source).not.toContain("${accessToken}");
    expect(source).not.toContain("error.message}");
  });

  test("it is a SEPARATE lane — the drainer is neither imported nor reused", () => {
    expect(source).not.toContain('from "./useBackgroundDrain"');
    expect(source).not.toContain("enqueueDrainWork");
    expect(source).not.toContain("backgroundSyncState");
  });

  test("the single-flight guard is the sync engine's, shared with Sync now", () => {
    expect(source).toContain("syncGoogleMeet");
  });

  test("the effect aborts its controller on unmount", () => {
    const at = source.indexOf("return () => {");
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 120)).toContain("controller.abort()");
  });
});

describe("app wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");

  test("rendering the mount point emits nothing and starts nothing", () => {
    const tcw = vault({ unlocked: true }).tcw;
    const html = renderToStaticMarkup(
      <GmeetSessionSync tcw={tcw} sessionStore={SESSION} backendUrl={BACKEND} />,
    );
    expect(html).toBe("");
    expect(hasGmeetSessionSyncRun()).toBe(false);
  });

  test("App mounts it behind the SAME ready gate as the drainer, with shell deps", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("<GmeetSessionSync");
    expect(at).toBeGreaterThan(0);
    expect(app.slice(at - 200, at)).toContain('state === "ready" && tcw &&');
    const usage = app.slice(at, app.indexOf("/>", at));
    expect(usage).toContain("tcw={tcw}");
    expect(usage).toContain("sessionStore={sessionStoreRef.current}");
    expect(usage).toContain("backendUrl={BACKEND_URL}");
    // Beside the drainer, not folded into it.
    expect(app).toContain("<BackgroundDrainer");
  });
});
