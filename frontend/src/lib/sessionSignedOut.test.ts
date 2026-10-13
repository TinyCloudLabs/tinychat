import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { SessionStore } from "@tinyboilerplate/client";
import { streamChat } from "./chatApi";
import { createTranscriberClient } from "./transcriberApi";
import { clearSessionAfterHandoff, registerSessionSignedOutHook } from "./sessionSignedOut";

test("a 401 clears credentials only after the registered native handoff", async () => {
  const order: string[] = [];
  const session = { clear: () => { order.push("clear"); } };
  const dispose = registerSessionSignedOutHook(session, async () => { order.push("handoff"); return true; });
  await clearSessionAfterHandoff(session);
  expect(order).toEqual(["handoff", "clear"]);
  dispose();
});

test("a chat or transcriber 401 moves the app to signed-out UI after the session clears", async () => {
  const order: string[] = [];
  let appState = "ready";
  const session = { clear: () => { order.push("clear"); } };
  const dispose = registerSessionSignedOutHook(session, async () => { order.push("handoff"); return true; },
    () => { order.push("ui"); appState = "unauthenticated"; });
  await clearSessionAfterHandoff(session);
  expect(order).toEqual(["handoff", "clear", "ui"]);
  expect(appState).toBe("unauthenticated");
  dispose();
});

test("the transcriber 401 path calls the UI completion after credential clearing", async () => {
  const order: string[] = [];
  const session = { getToken: () => "token", isExpired: () => false,
    clear: () => { order.push("clear"); } } as SessionStore;
  const dispose = registerSessionSignedOutHook(session, async () => { order.push("handoff"); return true; },
    () => { order.push("signed-out-ui"); });
  try {
    const client = createTranscriberClient("https://backend.example", { sessionStore: session,
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch });
    expect(await client.list()).toEqual({ status: "unauthenticated" });
    expect(order).toEqual(["handoff", "clear", "signed-out-ui"]);
  } finally { dispose(); }
});

test("the chat 401 path calls the UI completion after credential clearing", async () => {
  const originalFetch = globalThis.fetch;
  const order: string[] = [];
  const session = { getToken: () => "token", isExpired: () => false,
    clear: () => { order.push("clear"); } } as SessionStore;
  const dispose = registerSessionSignedOutHook(session, async () => { order.push("handoff"); return true; },
    () => { order.push("signed-out-ui"); });
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
  try {
    const stream = streamChat({ backendUrl: "https://backend.example", sessionStore: session,
      model: "test", messages: [{ role: "user", content: "hi" }] });
    await expect(stream.next()).rejects.toThrow("Session expired");
    expect(order).toEqual(["handoff", "clear", "signed-out-ui"]);
  } finally { globalThis.fetch = originalFetch; dispose(); }
});

test("a failed native handoff leaves the bearer session intact", async () => {
  let cleared = false;
  let uiChanged = false;
  const session = { clear: () => { cleared = true; } };
  const dispose = registerSessionSignedOutHook(session, async () => false, () => { uiChanged = true; });
  await expect(clearSessionAfterHandoff(session)).rejects.toThrow("Session was kept");
  expect(cleared).toBe(false);
  expect(uiChanged).toBe(false);
  dispose();
});

test("simultaneous 401 responses share one durable handoff", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let handoffs = 0;
  let clears = 0;
  const session = { clear: () => { clears++; } };
  const dispose = registerSessionSignedOutHook(session, async () => { handoffs++; await gate; return true; });
  const first = clearSessionAfterHandoff(session);
  const second = clearSessionAfterHandoff(session);
  expect(handoffs).toBe(1);
  expect(clears).toBe(0);
  release();
  await Promise.all([first, second]);
  expect(clears).toBe(2);
  dispose();
});

test("the App registers the shared clear completion that leaves ready UI", () => {
  const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  expect(app).toContain("registerSessionSignedOutHook(sessionStoreRef.current, captureHandoff,");
  expect(app).toContain("() => completeLocalSignOut(null)");
  const completion = app.slice(app.indexOf("const completeLocalSignOut = useCallback"),
    app.indexOf("useEffect(() => registerSessionSignedOutHook"));
  expect(completion).toContain("setTcw(null);");
  expect(completion).toContain('setState(terminal ? "unauthenticated" : warning ? "recoverableError" : "unauthenticated");');
});
