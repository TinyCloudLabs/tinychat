// RED-first tests for the app-shell mount point of W6 — the BROWSER RECONCILE
// (backend-ingest plan §8.1 W6).
//
// The engine (`lib/connectors/backendReconcile.ts`) has its own suite; what is
// asserted here is the wiring, which is where this feature can hurt something
// that already ships:
//
//   1. it renders NOTHING and starts nothing during render — a reconcile is
//      background work, never a gate on the shell;
//   2. it runs on the SAME serialized lane as the Option-C drain
//      (`enqueueDrainWork`), because both write the user's one space and
//      TinyCloud drops concurrent responses on it;
//   3. it never prompts and never logs — a locked vault is a quiet no-op, and a
//      meeting id is an identifier that must not reach the console;
//   4. the read-only meetings view is UNCHANGED: it still takes no `tcw`, so a
//      device with no vault still sees its meetings (W5's whole point). The
//      reconcile is a separate, additive mount;
//   5. App.tsx's drain-UX wiring is untouched.
//
// The frontend workspace has no DOM harness, so rendering goes through
// `react-dom/server` and the plumbing is source-asserted — the same call
// BackgroundSyncSection.test.tsx and MeetingsSection.test.tsx made.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { BackendReconciler, runBackendReconcile } from "./BackendReconciler";
import { meetingKvKey } from "@/lib/connectors/connectorStore";
import type { BackendReconcileMeetingsClient } from "@/lib/connectors/backendReconcile";

const SOURCE = "fireflies";

function fakeTcw(putKeys: string[]): TinyCloudWeb {
  return {
    kv: {
      put: async (key: string) => {
        putKeys.push(key);
        return { ok: true as const, data: { data: undefined, headers: {} } };
      },
    },
    sql: {
      db: () => {
        throw new Error("the reconcile is KV-only");
      },
    },
  } as unknown as TinyCloudWeb;
}

function fakeClient(): BackendReconcileMeetingsClient & { calls: string[] } {
  const calls: string[] = [];
  let listed = false;
  return {
    calls,
    async list() {
      calls.push("list");
      if (listed) {
        return {
          status: "ok",
          value: { source: SOURCE, meetings: [], nextCursor: null, hasMore: false },
        };
      }
      listed = true;
      return {
        status: "ok",
        value: {
          source: SOURCE,
          meetings: [
            {
              sourceId: "mtg-1",
              title: "Q3 planning sync",
              sizeBytes: 10,
              storedAt: "2026-08-10T12:00:00.000Z",
              updatedAt: "2026-08-10T12:00:00.000Z",
              hasTranscript: true,
              hasSummary: false,
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
      };
    },
    async read(source, sourceId) {
      calls.push(`read:${sourceId}`);
      return {
        status: "ok",
        value: {
          source,
          sourceId,
          meta: {
            sourceId,
            sizeBytes: 10,
            storedAt: "2026-08-10T12:00:00.000Z",
            updatedAt: "2026-08-10T12:00:00.000Z",
            hasTranscript: true,
            hasSummary: false,
          },
          content: { transcript: { sentences: [{ text: "hello" }] } },
        },
      };
    },
    async markReconciled(source, sourceId) {
      calls.push(`ack:${sourceId}`);
      return { status: "ok", value: { reconciled: true, source, sourceId } };
    },
  };
}

const SESSION = {
  getToken: () => "session-token",
  isExpired: () => false,
  clear: () => {},
} as never;

describe("BackendReconciler", () => {
  test("renders NOTHING and starts nothing during render", () => {
    const putKeys: string[] = [];
    const api = fakeClient();
    const markup = renderToStaticMarkup(
      <BackendReconciler
        tcw={fakeTcw(putKeys)}
        sessionStore={SESSION}
        backendUrl="https://backend.example"
        meetings={api}
      />,
    );
    expect(markup).toBe("");
    // Effects do not run under server rendering — and nothing may run outside one.
    expect(api.calls).toEqual([]);
    expect(putKeys).toEqual([]);
  });

  test("one run copies the unreconciled rows and acks them, and never throws", async () => {
    const putKeys: string[] = [];
    const api = fakeClient();
    await runBackendReconcile({
      tcw: fakeTcw(putKeys),
      sessionStore: SESSION,
      backendUrl: "https://backend.example",
      source: SOURCE,
      meetings: api,
      secrets: { isUnlocked: () => true },
    });
    expect(putKeys).toContain(meetingKvKey(SOURCE, "mtg-1"));
    expect(api.calls).toContain("ack:mtg-1");
  });

  test("a locked vault is a silent no-op — no request, no write, no prompt", async () => {
    const putKeys: string[] = [];
    const api = fakeClient();
    await runBackendReconcile({
      tcw: fakeTcw(putKeys),
      sessionStore: SESSION,
      backendUrl: "https://backend.example",
      source: SOURCE,
      meetings: api,
      secrets: { isUnlocked: () => false },
    });
    expect(api.calls).toEqual([]);
    expect(putKeys).toEqual([]);
  });

  test("a failing run is swallowed — background work never rejects into the shell", async () => {
    const api = fakeClient();
    const exploding = {
      ...api,
      list: async () => {
        throw new Error("network on fire");
      },
    } as BackendReconcileMeetingsClient;
    // No assertion beyond "this resolves": an unhandled rejection here would be a
    // console error on a surface that must stay silent.
    await runBackendReconcile({
      tcw: fakeTcw([]),
      sessionStore: SESSION,
      backendUrl: "https://backend.example",
      source: SOURCE,
      meetings: exploding,
      secrets: { isUnlocked: () => true },
    });
  });
});

// ── Wiring (source-asserted, as the drain and meetings suites do) ─────

describe("BackendReconciler wiring", () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, rel), "utf8");
  const MODULE = read("BackendReconciler.tsx");

  test("runs on the ONE serialized lane the Option-C drain uses", () => {
    // Both write the user's single space; overlapping them is exactly the
    // concurrency TinyCloud drops responses on.
    expect(MODULE).toContain("enqueueDrainWork");
    expect(MODULE).toContain("reconcileBackendMeetings");
  });

  test("never logs, never unlocks, never touches SQL", () => {
    expect(MODULE).not.toContain("console.");
    expect(MODULE).not.toContain("unlockSecrets");
    expect(MODULE).not.toContain("tcw.sql");
    // Re-armed by the same unlock event the drain listens for, so a vault unlocked
    // after sign-in still gets its copy without a poll.
    expect(MODULE).toContain("onSecretsUnlocked");
  });

  test("App mounts it behind the signed-in gate, with the shell's own deps", () => {
    const app = read("../App.tsx");
    const at = app.indexOf("<BackendReconciler");
    expect(at).toBeGreaterThan(0);
    expect(app.slice(at - 200, at)).toContain('state === "ready" && tcw &&');
    const usage = app.slice(at, app.indexOf("/>", at));
    expect(usage).toContain("tcw={tcw}");
    expect(usage).toContain("sessionStore={sessionStoreRef.current}");
    expect(usage).toContain("backendUrl={BACKEND_URL}");
  });

  test("the read-only meetings view is untouched — still no vault, still no tcw", () => {
    const app = read("../App.tsx");
    const section = read("MeetingsSection.tsx");
    // W5's contract: the meetings view works on a device that has no vault at all.
    expect(app).not.toMatch(/<MeetingsSection[\s\S]{0,240}tcw=\{/);
    expect(section).not.toContain("TinyCloudWeb");
    expect(section).not.toContain("markReconciled");
  });

  test("the drain-UX wiring App already had is untouched", () => {
    const app = read("../App.tsx");
    expect(app).toContain("clearBackgroundDrainRecord");
    expect(app).toContain("subscribeBackgroundDrainRecord");
    expect(app).toContain("<BackgroundDrainer");
  });
});
