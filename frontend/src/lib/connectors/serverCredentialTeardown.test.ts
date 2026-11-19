// TC-2778: turning Fireflies sync off or disconnecting removes the sign-in the SERVER holds, through the
// real webhooks client over a stubbed `fetch`. Every assertion is on what crossed the wire and what the
// owner is told.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";

import {
  disableBackgroundSync,
  initialBackgroundSyncState,
  type BackgroundSyncDeps,
  type BackgroundSyncState,
} from "@/chat/backgroundSyncState";
import {
  disconnectStatusMessage,
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectMode,
  type DisconnectProgress,
} from "./connectorLifecycle";
import {
  CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE,
  createConnectorWebhooksClient,
} from "./webhooksApi";

const SENTINEL = "sentinel-session-token-7f3a91c2";
const BACKEND = "https://api.example.test";
const CREDS = `${BACKEND}/api/connectors/credentials/fireflies`;
const CONFIG = `${BACKEND}/api/connectors/webhooks/config`;

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | "network-error";

let calls: Call[];
let answers: Record<string, Answer[]>;
let logged: string[];
const realFetch = globalThis.fetch;
const spies: Array<{ mockRestore: () => void }> = [];

function answer(method: string, url: string, ...replies: Answer[]): void {
  answers[`${method} ${url}`] = replies;
}

beforeEach(() => {
  calls = [];
  answers = {};
  logged = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
    }));
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      headers: { ...(init?.headers as Record<string, string>) },
      body: init?.body,
    });
    const queue = answers[key];
    const next = queue && queue.length > 0 ? (queue.length > 1 ? queue.shift()! : queue[0]) : undefined;
    if (next === undefined) throw new Error(`unexpected request ${key} Authorization: Bearer ${SENTINEL}`);
    if (next === "network-error") throw new Error(`connect failed Authorization: Bearer ${SENTINEL}`);
    return new Response(next.status === 204 ? null : JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  while (spies.length > 0) spies.pop()!.mockRestore();
});

const sessionStore = { getToken: () => SENTINEL, isExpired: () => false } as unknown as SessionStore;
const webhooks = () => createConnectorWebhooksClient(BACKEND, { sessionStore });

const connected = { status: 200, body: { connected: true, source: "fireflies", kind: "oauth" } };
const notConnected = { status: 200, body: { connected: false, source: "fireflies" } };
const deleted = { status: 200, body: { deleted: true, upstreamRevoked: true, contentRemoved: 0, queueDropped: 0 } };
const upstreamFailed = { status: 502, body: { error: "upstream_revoke_failed", deleted: true, upstreamRevoked: false } };
const revokeFailed = { status: 503, body: { error: "revoke_failed" } };
const configOff = { status: 200, body: { status: "disabled", queueDropped: 0 } };
const purgeOk = { status: 204 };
// The backend's own marker on a credential-route 404 (not mounted, or the owner is not enrolled).
const dark = { status: 404, body: { error: "not_found" }, headers: { "X-Route-Unavailable": "connector-credentials" } };
// A 404 from anywhere else: a proxy, a wrong path.
const unmarked404 = { status: 404, body: { error: "not_found" } };

const credCalls = () => calls.filter((c) => c.url === CREDS);
const deleteCreds = () => calls.filter((c) => c.method === "DELETE" && c.url === CREDS);

// ── The client ───────────────────────────────────────────────────────

describe("teardownCredential (client)", () => {
  test("a stored sign-in is read, then deleted once, with only the session auth and no body", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, deleted);
    const result = await webhooks().teardownCredential!("fireflies");
    expect(result).toEqual({ status: "ok", value: { deleted: true, upstreamRevoked: true, contentRemoved: 0, queueDropped: 0 } });
    expect(credCalls().map((c) => c.method)).toEqual(["GET", "DELETE"]);
    const del = deleteCreds()[0]!;
    expect(del.body).toBeUndefined();
    expect(Object.keys(del.headers).sort()).toEqual(["Authorization", "X-Requested-With"]);
  });

  test("not connected: the full DELETE is still sent once, with no body, and resolves ok with null", async () => {
    answer("GET", CREDS, notConnected);
    answer("DELETE", CREDS, { status: 200, body: { deleted: true, upstreamRevoked: false, contentRemoved: 0, queueDropped: 0 } });
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "ok", value: null });
    expect(credCalls().map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(deleteCreds()).toHaveLength(1);
    expect(deleteCreds()[0]!.body).toBeUndefined();
  });

  test("a 404 on the read (route dark) is feature-dark with no DELETE", async () => {
    answer("GET", CREDS, dark);
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "feature-dark" });
    expect(deleteCreds()).toHaveLength(0);
  });

  test("any other failed read is a failure, never a skip", async () => {
    answer("GET", CREDS, { status: 503, body: { error: "unavailable" } });
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "retryable", httpStatus: 503, code: "unavailable" });
    answer("GET", CREDS, { status: 200, body: { nothing: true } });
    expect((await webhooks().teardownCredential!("fireflies")).status).toBe("rejected");
    answer("GET", CREDS, "network-error");
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "offline" });
    expect(deleteCreds()).toHaveLength(0);
  });

  test("502 upstream_revoke_failed with deleted:true is a delete whose revoke was not confirmed", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, upstreamFailed);
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "ok", value: { deleted: true, upstreamRevoked: false } });
  });

  test("a 502 that does not say the sign-in was deleted, and a 503, stay retryable", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, { status: 502, body: { error: "upstream_revoke_failed", deleted: false } }, revokeFailed);
    expect((await webhooks().teardownCredential!("fireflies")).status).toBe("retryable");
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "retryable", httpStatus: 503, code: "revoke_failed" });
  });
});

// ── The disconnect runner ────────────────────────────────────────────

function disconnectDeps(
  mode: DisconnectMode,
  patch: Partial<DisconnectDeps> = {},
): { deps: DisconnectDeps; ops: string[]; seen: DisconnectProgress[]; emit: (u: (p: DisconnectProgress) => DisconnectProgress) => void } {
  const ops: string[] = [];
  const seen: DisconnectProgress[] = [];
  let current = initialDisconnectProgress(mode);
  const emit = (u: (p: DisconnectProgress) => DisconnectProgress) => {
    current = u(current);
    seen.push(current);
  };
  const deps: DisconnectDeps = {
    connectorId: "fireflies",
    source: "fireflies",
    mode,
    webhooks: webhooks(),
    secrets: {
      isUnlocked: () => true,
      unlock: async () => ({ ok: true }),
      deleteKey: async () => { ops.push("delete-key"); return { ok: true }; },
    },
    store: {
      listKnownSourceIds: async () => ({ ok: true, data: ["01JMEETINGAAA"] }),
      purgeConnector: async () => { ops.push("purge-local"); return { ok: true, data: undefined }; },
      clearFirefliesAttempt: async () => ({ ok: true, data: undefined }),
      getConnection: async () => ({ ok: true, data: null }),
      countMeetings: async () => ({ ok: true, data: 0 }),
      updateSyncState: async () => { ops.push("mark-disconnected"); return { ok: true, data: undefined }; },
    },
    ...patch,
  };
  return { deps, ops, seen, emit };
}

function happyWire(): void {
  answer("GET", CREDS, connected);
  answer("DELETE", CREDS, deleted);
  answer("DELETE", CONFIG, configOff);
  answer("POST", `${BACKEND}/api/connectors/webhooks/purged`, purgeOk);
}

describe("disconnect runs the server teardown", () => {
  for (const mode of ["keep-data", "delete-data"] as const) {
    test(`${mode}: the route is called exactly once, before delivery is switched off, and the plan completes`, async () => {
      happyWire();
      const { deps, ops, seen, emit } = disconnectDeps(mode);
      const final = await runDisconnect(deps, emit);
      expect(final.done).toBe(true);
      expect(final.notice).toBeUndefined();
      expect(deleteCreds()).toHaveLength(1);
      expect(final.completed).toContain("teardown-server-credential");
      const order = final.completed;
      expect(order.indexOf("teardown-server-credential")).toBeLessThan(order.indexOf("disable-webhooks"));
      expect(order.indexOf("disable-webhooks")).toBeLessThan(order.indexOf("delete-key"));
      if (mode === "delete-data") expect(order.indexOf("record-purge")).toBeLessThan(order.indexOf("teardown-server-credential"));
      expect(ops).toContain(mode === "delete-data" ? "purge-local" : "mark-disconnected");
      expect(seen.every((p) => p.failure === null)).toBe(true);
    });
  }

  test("502 upstream_revoke_failed: the step counts as deleted, the run is done, and the owner is told", async () => {
    happyWire();
    answer("DELETE", CREDS, upstreamFailed);
    const { deps, emit } = disconnectDeps("keep-data");
    const final = await runDisconnect(deps, emit);
    expect(final.done).toBe(true);
    expect(final.failure).toBeNull();
    expect(final.completed).toContain("teardown-server-credential");
    expect(final.notice).toBe(CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE);
    expect(disconnectStatusMessage(final)).toContain(CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE);
    expect(deleteCreds()).toHaveLength(1);
  });

  test("503 revoke_failed: the run stops retryably before the key is touched, and a retry calls the route again without re-running finished steps", async () => {
    happyWire();
    answer("DELETE", CREDS, revokeFailed, deleted);
    const first = disconnectDeps("delete-data");
    const failed = await runDisconnect(first.deps, first.emit);
    expect(failed.done).toBe(false);
    expect(failed.failure).toMatchObject({ step: "teardown-server-credential", retryable: true });
    expect(first.ops).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/purged"))).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE" && c.url === CONFIG)).toBe(false);

    const retry = disconnectDeps("delete-data");
    const final = await runDisconnect(retry.deps, retry.emit, failed);
    expect(final.done).toBe(true);
    expect(calls.filter((c) => c.url.endsWith("/purged"))).toHaveLength(1);
    expect(deleteCreds()).toHaveLength(2);
    expect(calls.filter((c) => c.method === "GET" && c.url === CREDS)).toHaveLength(2);
  });

  test("a failed read of the stored sign-in stops the run retryably; the DELETE is never sent", async () => {
    happyWire();
    answer("GET", CREDS, { status: 503, body: { error: "unavailable" } });
    const { deps, emit } = disconnectDeps("keep-data");
    const final = await runDisconnect(deps, emit);
    expect(final.done).toBe(false);
    expect(final.failure).toMatchObject({ step: "teardown-server-credential", retryable: true });
    expect(deleteCreds()).toHaveLength(0);
  });

  test("never connected: the DELETE is sent once and the run is quiet; the route dark sends no DELETE — done, no message", async () => {
    const absent = { status: 200, body: { deleted: true, upstreamRevoked: false, contentRemoved: 0, queueDropped: 0 } };
    for (const [stored, deletes] of [[notConnected, 1], [dark, 0]] as const) {
      calls = [];
      happyWire();
      answer("GET", CREDS, stored);
      answer("DELETE", CREDS, absent);
      const { deps, emit } = disconnectDeps("keep-data");
      const final = await runDisconnect(deps, emit);
      expect(final.done).toBe(true);
      expect(final.failure).toBeNull();
      expect(final.notice).toBeUndefined();
      expect(disconnectStatusMessage(final)).not.toContain("Fireflies didn't confirm");
      expect(deleteCreds()).toHaveLength(deletes);
    }
  });

  test("a non-Fireflies connector never calls the route", async () => {
    happyWire();
    const { deps, emit } = disconnectDeps("keep-data", { connectorId: "granola", source: "granola" });
    answer("DELETE", CONFIG, configOff);
    const final = await runDisconnect(deps, emit);
    expect(final.done).toBe(true);
    expect(final.completed).not.toContain("teardown-server-credential");
    expect(credCalls()).toHaveLength(0);
  });

  test("the session token appears in no log, progress, message or thrown error, on any outcome", async () => {
    const outcomes: Array<() => void> = [
      () => { happyWire(); },
      () => { happyWire(); answer("DELETE", CREDS, upstreamFailed); },
      () => { happyWire(); answer("DELETE", CREDS, revokeFailed); },
      () => { happyWire(); answer("GET", CREDS, "network-error"); },
      () => { happyWire(); answer("DELETE", CREDS, "network-error"); },
    ];
    const rendered: string[] = [];
    for (const arrange of outcomes) {
      arrange();
      const { deps, seen, emit } = disconnectDeps("keep-data");
      const final = await runDisconnect(deps, emit);
      rendered.push(JSON.stringify(seen), JSON.stringify(final), disconnectStatusMessage(final) ?? "");
    }
    expect([...rendered, ...logged].join("\n")).not.toContain(SENTINEL);
    expect([...rendered, ...logged].join("\n").toLowerCase()).not.toContain("authorization");
  });
});

// ── Turning sync off ─────────────────────────────────────────────────

function syncDeps(): { deps: BackgroundSyncDeps; state: () => BackgroundSyncState; emit: (u: (s: BackgroundSyncState) => BackgroundSyncState) => void } {
  let current = initialBackgroundSyncState();
  return {
    deps: {
      source: "fireflies",
      webhooks: webhooks() as unknown as BackgroundSyncDeps["webhooks"],
      secrets: { isUnlocked: () => true, unlock: async () => ({ ok: true }) },
      ingest: async () => { throw new Error("not used"); },
    },
    state: () => current,
    emit: (u) => { current = u(current); },
  };
}

describe("turning sync off runs the server teardown", () => {
  test("a stored sign-in is torn down once, before the config is disabled, and sync ends off", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, deleted);
    answer("DELETE", CONFIG, configOff);
    const { deps, state, emit } = syncDeps();
    await disableBackgroundSync(deps, emit);
    expect(state().phase).toBe("off");
    expect(deleteCreds()).toHaveLength(1);
    expect(calls.findIndex((c) => c.url === CREDS && c.method === "DELETE")).toBeLessThan(calls.findIndex((c) => c.url === CONFIG));
    expect(state().notice?.message).not.toContain("didn't confirm");
  });

  test("502 upstream_revoke_failed: sync still ends off and the notice says the revoke was not confirmed", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, upstreamFailed);
    answer("DELETE", CONFIG, configOff);
    const { deps, state, emit } = syncDeps();
    await disableBackgroundSync(deps, emit);
    expect(state().phase).toBe("off");
    expect(state().notice).toEqual({ tone: "error", message: CREDENTIAL_REVOKE_UNCONFIRMED_MESSAGE, retryable: false });
  });

  test("503 revoke_failed: the config is not disabled, the notice is retryable, and a retry calls the route again", async () => {
    answer("GET", CREDS, connected);
    answer("DELETE", CREDS, revokeFailed, deleted);
    answer("DELETE", CONFIG, configOff);
    const { deps, state, emit } = syncDeps();
    await disableBackgroundSync(deps, emit);
    expect(state().notice?.retryable).toBe(true);
    expect(state().phase).not.toBe("off");
    expect(calls.some((c) => c.url === CONFIG)).toBe(false);
    await disableBackgroundSync(deps, emit);
    expect(state().phase).toBe("off");
    expect(deleteCreds()).toHaveLength(2);
  });

  test("never connected: the DELETE is sent once with the ordinary off notice and no error; the route dark sends no DELETE", async () => {
    const absent = { status: 200, body: { deleted: true, upstreamRevoked: false, contentRemoved: 0, queueDropped: 0 } };
    for (const [stored, deletes] of [[notConnected, 1], [dark, 0]] as const) {
      calls = [];
      answer("GET", CREDS, stored);
      answer("DELETE", CREDS, absent);
      answer("DELETE", CONFIG, configOff);
      const { deps, state, emit } = syncDeps();
      await disableBackgroundSync(deps, emit);
      expect(state().phase).toBe("off");
      expect(state().notice?.tone).toBe("info");
      expect(state().notice?.message ?? "").not.toContain("Fireflies didn't confirm");
      expect(deleteCreds()).toHaveLength(deletes);
    }
  });

  test("another source never calls the route, and no token reaches a log or the notice", async () => {
    answer("DELETE", CONFIG, configOff);
    const other = syncDeps();
    other.deps.source = "granola";
    await disableBackgroundSync(other.deps, other.emit);
    expect(credCalls()).toHaveLength(0);

    answer("GET", CREDS, "network-error");
    const net = syncDeps();
    await disableBackgroundSync(net.deps, net.emit);
    expect(JSON.stringify(net.state()) + logged.join("\n")).not.toContain(SENTINEL);
  });
});

// ── A 404 is "not available here" only when the backend says so ─────────

describe("an unmarked 404 on the read is a failure, not a skip", () => {
  test("client: a marked 404 is feature-dark; an unmarked one is retryable; neither sends a DELETE", async () => {
    answer("GET", CREDS, dark);
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "feature-dark" });
    answer("GET", CREDS, unmarked404);
    expect(await webhooks().teardownCredential!("fireflies")).toEqual({ status: "retryable", httpStatus: 404, code: "not_found" });
    expect(deleteCreds()).toHaveLength(0);
  });

  for (const mode of ["keep-data", "delete-data"] as const) {
    test(`${mode}: an unmarked 404 stops the disconnect at the server step and keeps the API key`, async () => {
      happyWire();
      answer("GET", CREDS, unmarked404);
      const { deps, ops, emit } = disconnectDeps(mode);
      const final = await runDisconnect(deps, emit);
      expect(final.done).toBe(false);
      expect(final.failure).toMatchObject({ step: "teardown-server-credential", retryable: true });
      expect(final.completed).not.toContain("disable-webhooks");
      expect(ops).not.toContain("delete-key");
      expect(deleteCreds()).toHaveLength(0);
    });
  }

  test("sync off: an unmarked 404 leaves sync on with a retryable notice; the config is not disabled", async () => {
    answer("GET", CREDS, unmarked404);
    answer("DELETE", CONFIG, configOff);
    const { deps, state, emit } = syncDeps();
    await disableBackgroundSync(deps, emit);
    expect(state().phase).not.toBe("off");
    expect(state().notice?.retryable).toBe(true);
    expect(calls.some((c) => c.url === CONFIG)).toBe(false);
    expect(deleteCreds()).toHaveLength(0);
  });
});
