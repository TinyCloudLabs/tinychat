// TC-514 — launching offline must not sign the user out.
//
// The boot restore used to clear the backend Bearer session on ANY failure, so
// a phone opening the app without signal (manifest fetch → TypeError) lost a
// perfectly good session and "Try again" ran a full OpenKey sign-in. These
// tests pin the split between "couldn't reach" (keep everything, retry) and "the
// session itself was refused" (clear, exactly as before), the retry path that
// recovers a held session without OpenKey, and the App wiring that routes
// "Try again" / the `online` event to the restore instead of sign-in.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyRestoreFailure,
  isTransientRestoreError,
  restorePersistedSession,
  restoreUnavailableMessage,
  type RestoreAttempt,
  type RestoreDeps,
  type RestoreSessionStore,
} from "./sessionRestore";
import { handoffBeforeCredentialClear } from "./voiceNotes/accountHandoff";
import { createFakeVoiceNotes } from "./voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests, VoiceNotes } from "./voiceNotes/nativeVoiceNotes";

const ADDRESS = "0x0000000000000000000000000000000000000001";

class FakeSessionStore implements RestoreSessionStore {
  cleared = 0;
  constructor(
    private session: { token: string; address?: string; expired?: boolean } | null,
  ) {}
  hasSession() {
    return this.session !== null;
  }
  isExpired() {
    return this.session === null || this.session.expired === true;
  }
  getAddress() {
    return this.session?.address ?? null;
  }
  getToken() {
    return this.session?.token ?? null;
  }
  clear() {
    this.cleared += 1;
    this.session = null;
  }
}

const MANIFEST = { app_id: "xyz.tinycloud.tinychat" };
const TCW = { did: `did:pkh:eip155:1:${ADDRESS}`, spaceId: "tinycloud:space" };
type Tcw = typeof TCW;

test("a definitive restore verdict waits for capture handoff before clearing credentials", async () => {
  const store = new FakeSessionStore({ token: "token", address: ADDRESS });
  const order: string[] = [];
  const originalClear = store.clear.bind(store);
  store.clear = () => { order.push("clear"); originalClear(); };
  await restorePersistedSession(store, {
    isOffline: () => false,
    loadManifest: async () => MANIFEST,
    restore: async () => ({ status: "expired", tcw: null }),
    beforeClear: async () => { order.push("handoff"); },
  });
  expect(order).toEqual(["handoff", "clear"]);
});

test("a failed capture handoff preserves the persisted session", async () => {
  const store = new FakeSessionStore({ token: "token", address: ADDRESS });
  await expect(restorePersistedSession(store, {
    isOffline: () => false,
    loadManifest: async () => MANIFEST,
    restore: async () => ({ status: "expired", tcw: null }),
    beforeClear: async () => { throw new Error("disk failed"); },
  })).rejects.toThrow("disk failed");
  expect(store.cleared).toBe(0);
});

function deps(over: Partial<RestoreDeps<typeof MANIFEST, Tcw>> = {}) {
  const calls = { manifest: 0, restore: [] as string[] };
  const d: RestoreDeps<typeof MANIFEST, Tcw> = {
    isOffline: () => false,
    ...over,
    loadManifest: async () => {
      calls.manifest += 1;
      return (over.loadManifest ?? (async () => MANIFEST))();
    },
    restore: async (address, manifest) => {
      calls.restore.push(address);
      return (over.restore ?? (async (): Promise<RestoreAttempt<Tcw>> => ({ status: "restored", tcw: TCW })))(
        address,
        manifest,
      );
    },
  };
  return { d, calls };
}

const signedIn = () => new FakeSessionStore({ token: "bearer", address: ADDRESS });
const offlineFetch = () => Promise.reject(new TypeError("Failed to fetch"));

test("Moto stale signed-in native state with no web session becomes unowned on cold shortcut", async () => {
  const previous = VoiceNotes;
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: "did:example:old", transitionGen: 16,
      transcriber: "private-cloud", identifySpeakers: false });
    const store = new FakeSessionStore(null);
    const outcome = await restorePersistedSession(store, {
      isOffline: () => false, loadManifest: async () => MANIFEST,
      restore: async () => ({ status: "missing", tcw: null }),
      beforeClear: async () => {
        const native = await fake.plugin.getCaptureDefaults();
        const result = await handoffBeforeCredentialClear(native.accountDid, null);
        if (!result.ok) throw new Error(result.message ?? "Native handoff failed");
      },
    });
    expect(outcome.kind).toBe("signedOut");
    expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_out");
    await fake.plugin.start();
    expect(await fake.plugin.status()).toMatchObject({ owner: null, options: { transcriber: "on-device" } });
  } finally { __setVoiceNotesForTests(previous, { available: null }); }
});

test("offline boot keeps a held web session and native signed-in account untouched", async () => {
  const previous = VoiceNotes;
  const fake = createFakeVoiceNotes();
  __setVoiceNotesForTests(fake.plugin, { available: true });
  try {
    await fake.plugin.setCaptureDefaults({ accountDid: "did:example:held", transitionGen: 2,
      transcriber: "private-cloud", identifySpeakers: false });
    let handoffs = 0;
    const outcome = await restorePersistedSession(new FakeSessionStore({ token: "bearer", address: ADDRESS }), {
      isOffline: () => true,
      loadManifest: async () => { throw new TypeError("Failed to fetch"); },
      restore: async () => ({ status: "restored", tcw: TCW }),
      beforeClear: async () => { handoffs++; },
    });
    expect(outcome.kind).toBe("unavailable");
    expect(handoffs).toBe(0);
    expect((await fake.plugin.getCaptureDefaults()).status).toBe("signed_in");
  } finally { __setVoiceNotesForTests(previous, { available: null }); }
});

describe("isTransientRestoreError", () => {
  test("network-level fetch failures from every engine are transient", () => {
    for (const message of [
      "Failed to fetch", // Chromium / Android WebView
      "NetworkError when attempting to fetch resource.", // Firefox
      "Load failed", // Safari / WKWebView
      "Network request failed",
      "fetch failed", // undici
    ]) {
      expect(isTransientRestoreError(new TypeError(message))).toBe(true);
    }
  });

  test("aborts, timeouts and 408/429/5xx are transient", () => {
    expect(isTransientRestoreError(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isTransientRestoreError(new DOMException("slow", "TimeoutError"))).toBe(true);
    expect(isTransientRestoreError(new Error("request timed out"))).toBe(true);
    expect(isTransientRestoreError(Object.assign(new Error("x"), { status: 503 }))).toBe(true);
    expect(isTransientRestoreError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(
      isTransientRestoreError(new Error("failed to fetch manifest from https://x/api/manifest: HTTP 502")),
    ).toBe(true);
  });

  test("a wrapped network error is still found through `cause`", () => {
    const wrapped = new Error("Could not resolve TinyCloud host", {
      cause: new TypeError("Failed to fetch"),
    });
    expect(isTransientRestoreError(wrapped)).toBe(true);
  });

  test("auth refusals and programming errors are not transient", () => {
    expect(
      isTransientRestoreError(new Error("Persisted session has an invalid private Ed25519 session key.")),
    ).toBe(false);
    expect(isTransientRestoreError(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isTransientRestoreError(Object.assign(new Error("x"), { status: 401 }))).toBe(false);
    expect(isTransientRestoreError(new Error("HTTP 403"))).toBe(false);
    expect(isTransientRestoreError(undefined)).toBe(false);
  });
});

describe("classifyRestoreFailure", () => {
  test("verdicts read from the stored session are auth failures, even offline", () => {
    for (const status of ["missing", "expired", "corrupt", "stale", "storage-unavailable", "disabled"]) {
      expect(classifyRestoreFailure({ status }, false)).toBe("auth");
      expect(classifyRestoreFailure({ status }, true)).toBe("auth");
    }
  });

  test("restore-failed is transient when the cause is the network", () => {
    expect(
      classifyRestoreFailure({ status: "restore-failed", error: new TypeError("Failed to fetch") }, false),
    ).toBe("transient");
  });

  test("restore-failed is transient whenever the device is offline", () => {
    expect(
      classifyRestoreFailure({ status: "restore-failed", error: new Error("host lookup failed") }, true),
    ).toBe("transient");
  });

  test("restore-failed with a non-network error while online is an auth failure", () => {
    expect(
      classifyRestoreFailure(
        { status: "restore-failed", error: new Error("Persisted session has an invalid private Ed25519 session key.") },
        false,
      ),
    ).toBe("auth");
  });
});

describe("restorePersistedSession", () => {
  test("restores a valid session", async () => {
    const store = signedIn();
    const { d, calls } = deps();
    expect(await restorePersistedSession(store, d)).toEqual({ kind: "restored", address: ADDRESS, tcw: TCW });
    expect(calls.restore).toEqual([ADDRESS]);
    expect(store.cleared).toBe(0);
  });

  test("no session or an expired one is signed out without touching the network", async () => {
    for (const store of [new FakeSessionStore(null), new FakeSessionStore({ token: "t", address: ADDRESS, expired: true })]) {
      const { d, calls } = deps();
      expect(await restorePersistedSession(store, d)).toEqual({ kind: "signedOut" });
      expect(calls.manifest).toBe(0);
    }
  });

  test("a session without an address is cleared, as before", async () => {
    const store = new FakeSessionStore({ token: "t" });
    expect(await restorePersistedSession(store, deps().d)).toEqual({ kind: "signedOut" });
    expect(store.cleared).toBe(1);
  });

  test("offline launch: the manifest fetch fails, the session is KEPT, the message says offline", async () => {
    const store = signedIn();
    const { d, calls } = deps({ loadManifest: offlineFetch, isOffline: () => true });
    expect(await restorePersistedSession(store, d)).toEqual({
      kind: "unavailable",
      message: "You're offline. Exo will reconnect when you're back online.",
    });
    expect(store.cleared).toBe(0);
    expect(store.getToken()).toBe("bearer");
    // The TinyCloud restore never ran, so the persisted TinyCloud session was
    // never read, let alone discarded — and no manifest-less client exists.
    expect(calls.restore).toEqual([]);
  });

  test("backend unreachable while online (5xx / manifest unavailable) keeps the session too", async () => {
    const store = signedIn();
    const { d } = deps({ loadManifest: () => Promise.reject(new Error("Could not load the TinyCloud app manifest")) });
    expect(await restorePersistedSession(store, d)).toEqual({
      kind: "unavailable",
      message: restoreUnavailableMessage(false),
    });
    expect(store.cleared).toBe(0);
  });

  test("a network failure inside the TinyCloud restore keeps the session", async () => {
    const store = signedIn();
    const { d } = deps({
      restore: async () => ({ status: "restore-failed", tcw: null, error: new TypeError("Failed to fetch") }),
    });
    expect((await restorePersistedSession(store, d)).kind).toBe("unavailable");
    expect(store.cleared).toBe(0);
  });

  test("an expired or corrupt TinyCloud session still clears and signs out", async () => {
    for (const status of ["expired", "corrupt", "stale", "missing"]) {
      const store = signedIn();
      const { d } = deps({ restore: async () => ({ status, tcw: null }) });
      expect(await restorePersistedSession(store, d)).toEqual({ kind: "signedOut" });
      expect(store.cleared).toBe(1);
    }
  });

  test("a non-network restore failure while online still clears and signs out", async () => {
    const store = signedIn();
    const { d } = deps({
      restore: async () => ({ status: "restore-failed", tcw: null, error: new Error("invalid session key") }),
    });
    expect(await restorePersistedSession(store, d)).toEqual({ kind: "signedOut" });
    expect(store.cleared).toBe(1);
  });

  test("an unexpected throw is classified the same way", async () => {
    const network = signedIn();
    expect(
      (await restorePersistedSession(network, deps({ restore: () => Promise.reject(new TypeError("Load failed")) }).d)).kind,
    ).toBe("unavailable");
    expect(network.cleared).toBe(0);

    const broken = signedIn();
    expect(
      await restorePersistedSession(broken, deps({ restore: () => Promise.reject(new Error("bad config")) }).d),
    ).toEqual({ kind: "failed", message: "bad config" });
    expect(broken.cleared).toBe(1);
  });

  test("retry path: the held session restores once the network is back, with no sign-in", async () => {
    const store = signedIn();
    let online = false;
    const { d, calls } = deps({
      isOffline: () => !online,
      loadManifest: () => (online ? Promise.resolve(MANIFEST) : offlineFetch()),
    });

    expect((await restorePersistedSession(store, d)).kind).toBe("unavailable");
    // A second "Try again" while still offline changes nothing either.
    expect((await restorePersistedSession(store, d)).kind).toBe("unavailable");
    expect(store.cleared).toBe(0);

    online = true;
    expect(await restorePersistedSession(store, d)).toEqual({ kind: "restored", address: ADDRESS, tcw: TCW });
    expect(calls.restore).toEqual([ADDRESS]);
    expect(store.cleared).toBe(0);
  });
});

// The React wiring is asserted against the source, like the rest of App's
// wiring (encryptionGrant.test.ts, authRouting.test.ts): the frontend has no
// DOM harness, and rendering App needs a mock wallet.
describe("App wiring (TC-514)", () => {
  const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
  const restoreRegion = app.slice(
    app.indexOf("// Restore an existing session on boot"),
    app.indexOf("// A1 — keep the policy-input refs"),
  );

  test("boot runs the same callable restore that retry uses", () => {
    expect(restoreRegion).toContain("const restoreSession = useCallback(async () => {");
    expect(restoreRegion).toContain("await restorePersistedSession(sessionStoreRef.current, {");
    expect(restoreRegion).toMatch(/restoredRef\.current = true;\s+void restoreSession\(\);/);
  });

  test("the restore path no longer clears the session on its own", () => {
    // The browser/widget restore still delegates its verdict to
    // lib/sessionRestore. Native E1 boot cleanup is a separate earlier path.
    const browserRestore = restoreRegion.slice(restoreRegion.indexOf("const restored = await restorePersistedSession"));
    expect(browserRestore).not.toContain(".clear()");
    expect(browserRestore).not.toMatch(/catch \(caught\) \{\s+sessionStore\.clear\(\)/);
  });

  test("a held session lands in `offline`, a verdict in the old states", () => {
    expect(restoreRegion).toMatch(/case "unavailable":\s+setError\(restored\.message\);\s+setState\("offline"\);/);
    expect(restoreRegion).toMatch(/case "signedOut":\s+if \(!await captureHandoff\(\)\).*setState\("unauthenticated"\);/s);
    expect(restoreRegion).toMatch(/case "failed":\s+setError\(restored\.message\);\s+setState\("recoverableError"\);/);
  });

  test("Try again re-runs the restore while offline and signs in otherwise", () => {
    expect(app).toContain('const authAction = state === "offline" ? restoreSession : signIn;');
    // The sign-in surface is the one place with the action (the app header and
    // its button went with the shell, TC-761).
    expect(app).toMatch(/<BootSurface\s+state=\{state\}\s+error=\{error\}\s+onAction=\{authAction\}/);
    // No sign-in button is wired straight to OpenKey any more.
    expect(app).not.toContain("onClick={signIn}");
    expect(app).not.toContain("onSignIn={signIn}");
  });

  test("coming back online re-runs the restore, only while a session is held", () => {
    const effect = restoreRegion.slice(restoreRegion.indexOf('if (state !== "offline") return;'));
    expect(effect).toContain('window.addEventListener("online", onOnline);');
    expect(effect).toContain('window.removeEventListener("online", onOnline);');
    expect(effect).toContain("const onOnline = () => void restoreSession();");
  });
});
