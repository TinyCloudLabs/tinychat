import { afterEach, beforeEach, expect, test } from "bun:test";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";
import { ModelSelectionCoordinator } from "./modelSelection";
import { clearSessionAfterHandoff, registerSessionSignedOutHook } from "../lib/sessionSignedOut";

// The model-selection lookup runs on every new chat. Only a 401 the session's own renewal cannot answer may sign
// the user out; a missing bearer or a 403 must leave the session, and everything this device keeps, alone.

type Call = { authorization: string | null };
let calls: Call[];
let statuses: number[];
const previousFetch = globalThis.fetch;
beforeEach(() => {
  calls = [];
  statuses = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ authorization: headers.get("Authorization") });
    const status = statuses.shift() ?? 200;
    return status === 200
      ? Response.json({ model: OFFERED_CHAT_MODELS[1].id, reason: "healthy" })
      : Response.json({ error: "refused" }, { status });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = previousFetch; });

/** The app's wiring: the session store, the signed-out hook (handoff, sign-out, renewal) and the auth-failure path. */
function app(initialToken: string | null, renew?: (session: { token: string | null }) => void) {
  const session = {
    token: initialToken,
    cleared: 0,
    getToken() { return this.token; },
    isExpired() { return false; },
    hasSession() { return this.token !== null; },
    clear() { this.cleared++; this.token = null; },
  };
  const events: string[] = [];
  const unregister = registerSessionSignedOutHook(session,
    async () => { events.push("handoff"); return true; },
    () => { events.push("signed-out"); },
    renew ? async () => { events.push("renew"); renew(session); } : undefined);
  const selection = new ModelSelectionCoordinator({
    tcw: {} as never,
    // Unique per test: the coordinator shares overlapping lookups by backend and bearer.
    backendUrl: `https://selection-${crypto.randomUUID()}.test`,
    sessionStore: session as never,
    onView: () => {},
    onAuthFailure: () => { events.push("auth-failure"); void clearSessionAfterHandoff(session).catch(() => undefined); },
  });
  return { session, events, selection, dispose() { selection.dispose(); unregister(); } };
}

async function settled(selection: ModelSelectionCoordinator) {
  for (let i = 0; i < 200 && selection.getView().phase === "choosing"; i++) await Bun.sleep(2);
  // Let a sign-out the lookup started (handoff, then clear) finish before anything is checked.
  for (let i = 0; i < 50; i++) await Promise.resolve();
  expect(selection.getView().phase).not.toBe("choosing");
}

test("a 403 from model selection signs nobody out and clears nothing: the choice is unverified and the session stays", async () => {
  const { session, events, selection, dispose } = app("bearer-a", () => { throw new Error("a 403 must not renew"); });
  statuses = [403];
  try {
    selection.activate("new-thread", "new");
    await settled(selection);
    expect(calls).toEqual([{ authorization: "Bearer bearer-a" }]);
    expect(selection.getView()).toMatchObject({ reason: "health-unverified", model: OFFERED_CHAT_MODELS[0].id, canSend: true });
    // No renewal, no auth failure, no handoff and no sign-out of either kind: the hook never ran.
    expect(events).toEqual([]);
    expect(session.cleared).toBe(0);
    expect(session.getToken()).toBe("bearer-a");
  } finally { dispose(); }
});

test("with no bearer the lookup sends nothing and signs nobody out", async () => {
  const { session, events, selection, dispose } = app(null);
  try {
    selection.activate("new-thread", "new");
    await settled(selection);
    expect(calls).toEqual([]);
    expect(selection.getView()).toMatchObject({ reason: "health-unverified", model: OFFERED_CHAT_MODELS[0].id });
    expect(events).toEqual([]);
    expect(session.cleared).toBe(0);
  } finally { dispose(); }
});

test("a 401 renews once and asks again with the renewed bearer; nobody is signed out", async () => {
  const { session, events, selection, dispose } = app("old-bearer", (current) => { current.token = "renewed-bearer"; });
  statuses = [401, 200];
  try {
    selection.activate("new-thread", "new");
    await settled(selection);
    expect(calls).toEqual([{ authorization: "Bearer old-bearer" }, { authorization: "Bearer renewed-bearer" }]);
    expect(selection.getView()).toMatchObject({ reason: "healthy", model: OFFERED_CHAT_MODELS[1].id, canSend: true });
    expect(events).toEqual(["renew"]);
    expect(session.cleared).toBe(0);
  } finally { dispose(); }
});

test("a 401 that renewal cannot answer signs out once, after the one renewal", async () => {
  const { session, events, selection, dispose } = app("old-bearer", () => { /* Renewal not due: the bearer stays. */ });
  statuses = [401];
  try {
    selection.activate("new-thread", "new");
    await settled(selection);
    expect(calls).toEqual([{ authorization: "Bearer old-bearer" }]);
    expect(selection.getView().canSend).toBe(false);
    expect(events).toEqual(["renew", "auth-failure", "handoff", "signed-out"]);
    expect(session.cleared).toBe(1);
  } finally { dispose(); }
});

test("a renewed bearer that is refused too signs out; renewal is not tried a second time", async () => {
  const { events, selection, dispose } = app("old-bearer", (current) => { current.token = "renewed-bearer"; });
  statuses = [401, 401];
  try {
    selection.activate("new-thread", "new");
    await settled(selection);
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer old-bearer", "Bearer renewed-bearer"]);
    expect(events).toEqual(["renew", "auth-failure", "handoff", "signed-out"]);
  } finally { dispose(); }
});
