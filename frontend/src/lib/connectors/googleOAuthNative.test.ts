// TC-521 — the Exo native app's system-browser Google OAuth.
//
// The dialog itself has no DOM harness here (see ConnectorsCard.test.ts), so the
// native return's decisions live in `googleOAuthNative.ts` and are tested
// directly: which URLs count as this attempt's return, and the attempt's
// lifecycle against fake Browser/App ports (including the Android race where the
// Custom Tab's close and the deep link arrive in either order). The dialog's use
// of it is pinned against the source in ConnectorsCard.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BROWSER_CLOSED_GRACE_MS,
  NATIVE_OAUTH_NOT_COMPLETED,
  NATIVE_OAUTH_RETURN_URL,
  NATIVE_OAUTH_STATE_PREFIX,
  nativeGoogleOAuthEnabled,
  nativeOAuthState,
  parseNativeOAuthReturn,
  startNativeOAuth,
  type NativeListenerHandle,
  type NativeOAuthOutcome,
  type NativeOAuthPorts,
} from "./googleOAuthNative";

const STATE = nativeOAuthState("Q2hhbmdlTWVQbGVhc2VfMDEyMzQ1Njc4OQ");
const OTHER_STATE = nativeOAuthState("T3RoZXJBdHRlbXB0XzAxMjM0NTY3ODlhYg");
/** Google codes carry `/`; the backend URL-encodes them into the deep link. */
const CODE = "4/0AQSTgQExample-code_with/slash";

/** What the backend's `nativeOAuthReturnUrl` produces (URLSearchParams, code first). */
function returnUrl(params: Record<string, string>): string {
  return `${NATIVE_OAUTH_RETURN_URL}?${new URLSearchParams(params).toString()}`;
}

describe("parseNativeOAuthReturn", () => {
  test("accepts this attempt's code return and decodes it", () => {
    expect(parseNativeOAuthReturn(returnUrl({ code: CODE, state: STATE }), STATE)).toEqual({
      kind: "code",
      code: CODE,
    });
  });

  test("accepts the backend's constant not-completed return", () => {
    expect(
      parseNativeOAuthReturn(returnUrl({ error: NATIVE_OAUTH_NOT_COMPLETED, state: STATE }), STATE),
    ).toEqual({ kind: "not-completed" });
  });

  for (const [label, url] of [
    ["another attempt's state", returnUrl({ code: CODE, state: OTHER_STATE })],
    ["no state", returnUrl({ code: CODE })],
    ["a repeated state", `${returnUrl({ code: CODE, state: STATE })}&state=${STATE}`],
    ["a repeated code", `${returnUrl({ code: CODE, state: STATE })}&code=second`],
    ["a code and an error", `${returnUrl({ code: CODE, state: STATE })}&error=${NATIVE_OAUTH_NOT_COMPLETED}`],
    ["an extra parameter", `${returnUrl({ code: CODE, state: STATE })}&redirect=https%3A%2F%2Fevil`],
    ["an empty code", returnUrl({ code: "", state: STATE })],
    ["an error the backend never sends", returnUrl({ error: "access_denied", state: STATE })],
    ["a fragment", `${returnUrl({ code: CODE, state: STATE })}#frag`],
    ["another scheme", `https://evil.example/oauth/google?code=${CODE}&state=${STATE}`],
    ["a look-alike scheme", `xyz.tinycloud.exo.evil://oauth/google?code=x&state=${STATE}`],
    ["a look-alike path", `xyz.tinycloud.exo://oauth/googlex?code=x&state=${STATE}`],
    ["a deeper path", `xyz.tinycloud.exo://oauth/google/evil?code=x&state=${STATE}`],
    ["another host", `xyz.tinycloud.exo://evil/google?code=x&state=${STATE}`],
    ["no query", NATIVE_OAUTH_RETURN_URL],
  ] as const) {
    test(`ignores ${label}`, () => {
      expect(parseNativeOAuthReturn(url, STATE)).toBeNull();
    });
  }

  test("never matches a state that is not native-tagged", () => {
    const untagged = "Q2hhbmdlTWVQbGVhc2VfMDEyMzQ1Njc4OQ";
    expect(parseNativeOAuthReturn(returnUrl({ code: CODE, state: untagged }), untagged)).toBeNull();
  });

  test("native states carry the tag the backend expects", () => {
    expect(STATE.startsWith(NATIVE_OAUTH_STATE_PREFIX)).toBe(true);
    expect(STATE).toMatch(/^native\.[A-Za-z0-9_-]{16,}$/);
  });
});

// ── The attempt's lifecycle ──────────────────────────────────────────

interface FakePorts extends NativeOAuthPorts {
  events: string[];
  openUrl(url: string): void;
  closeTab(): void;
  listeners(): number;
  closeCalls: number;
}

function fakePorts(options: {
  openFails?: boolean;
  registerFails?: "url" | "closed";
  closeRejects?: boolean;
  holdRegistration?: Promise<void>;
  /** openBrowser resolves only when this does (the browser is still being presented). */
  holdOpen?: Promise<void>;
} = {}): FakePorts {
  const urlListeners = new Set<(url: string) => void>();
  const closedListeners = new Set<() => void>();
  const events: string[] = [];
  const handle = <T>(set: Set<T>, listener: T, name: string): NativeListenerHandle => ({
    remove: () => {
      set.delete(listener);
      events.push(`remove:${name}`);
    },
  });
  const ports: FakePorts = {
    events,
    closeCalls: 0,
    async openBrowser(url) {
      events.push(`open:${url}`);
      await options.holdOpen;
      if (options.openFails) throw new Error("no browser");
    },
    async closeBrowser() {
      ports.closeCalls++;
      events.push("close");
      if (options.closeRejects) throw new Error("No active window to close!");
    },
    async onBrowserClosed(listener) {
      await options.holdRegistration;
      if (options.registerFails === "closed") throw new Error("not implemented");
      closedListeners.add(listener);
      events.push("listen:closed");
      return handle(closedListeners, listener, "closed");
    },
    async onAppUrlOpen(listener) {
      await options.holdRegistration;
      if (options.registerFails === "url") throw new Error("not implemented");
      urlListeners.add(listener);
      events.push("listen:url");
      return handle(urlListeners, listener, "url");
    },
    openUrl(url) {
      for (const listener of [...urlListeners]) listener(url);
    },
    closeTab() {
      for (const listener of [...closedListeners]) listener();
    },
    listeners: () => urlListeners.size + closedListeners.size,
  };
  return ports;
}

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    set(callback: () => void, ms: number) {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clear(id: unknown) {
      pending.delete(id as number);
    },
    fire() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, { callback }] of due) callback();
    },
    get delays() {
      return [...pending.values()].map((entry) => entry.ms);
    },
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function start(ports: FakePorts, timers = fakeTimers()) {
  const outcomes: NativeOAuthOutcome[] = [];
  const attempt = startNativeOAuth({
    ports,
    url: "https://api.example.test/api/connectors/google/oauth/start?state=x&challenge=y",
    expectedState: STATE,
    onOutcome: (outcome) => outcomes.push(outcome),
    timers,
  });
  return { attempt, outcomes, timers };
}

describe("startNativeOAuth", () => {
  test("listens for the return BEFORE it opens the browser", async () => {
    const ports = fakePorts();
    start(ports);
    await flush();
    const open = ports.events.findIndex((event) => event.startsWith("open:"));
    expect(open).toBeGreaterThan(ports.events.indexOf("listen:url"));
    expect(open).toBeGreaterThan(ports.events.indexOf("listen:closed"));
  });

  test("this attempt's return yields its code once, then cleans up and dismisses the browser", async () => {
    const ports = fakePorts();
    const { outcomes } = start(ports);
    await flush();
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    ports.openUrl(returnUrl({ code: "replayed", state: STATE }));
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
    expect(ports.listeners()).toBe(0);
    // iOS leaves SFSafariViewController over the app until it is dismissed.
    expect(ports.closeCalls).toBe(1);
  });

  test("stale, forged and unrelated URLs are ignored and the attempt keeps waiting", async () => {
    const ports = fakePorts();
    const { outcomes } = start(ports);
    await flush();
    ports.openUrl(returnUrl({ code: "stale", state: OTHER_STATE }));
    ports.openUrl(`https://evil.example/?code=x&state=${STATE}`);
    ports.openUrl("xyz.tinycloud.exo://somewhere-else");
    expect(outcomes).toEqual([]);
    expect(ports.listeners()).toBe(2);
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
  });

  test("the backend's not-completed return is a cancel", async () => {
    const ports = fakePorts();
    const { outcomes } = start(ports);
    await flush();
    ports.openUrl(returnUrl({ error: NATIVE_OAUTH_NOT_COMPLETED, state: STATE }));
    expect(outcomes).toEqual([{ kind: "cancelled" }]);
    expect(ports.listeners()).toBe(0);
  });

  test("Android race: the tab closes first, the deep link lands inside the grace period", async () => {
    const ports = fakePorts();
    const { outcomes, timers } = start(ports);
    await flush();
    ports.closeTab();
    expect(timers.delays).toEqual([BROWSER_CLOSED_GRACE_MS]);
    expect(outcomes).toEqual([]);
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
    // The grace timer was cleared: firing it now changes nothing.
    timers.fire();
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
  });

  test("a browser closed with no return is a cancel once the grace period ends", async () => {
    const ports = fakePorts();
    const { outcomes, timers } = start(ports);
    await flush();
    ports.closeTab();
    ports.closeTab();
    expect(timers.delays).toEqual([BROWSER_CLOSED_GRACE_MS]);
    timers.fire();
    expect(outcomes).toEqual([{ kind: "cancelled" }]);
    expect(ports.listeners()).toBe(0);
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    expect(outcomes).toEqual([{ kind: "cancelled" }]);
  });

  test("a browser that cannot open is reported, and nothing is left listening", async () => {
    const ports = fakePorts({ openFails: true });
    const { outcomes } = start(ports);
    await flush();
    expect(outcomes).toEqual([{ kind: "browser-unavailable" }]);
    expect(ports.listeners()).toBe(0);
  });

  for (const registerFails of ["url", "closed"] as const) {
    test(`a missing ${registerFails} listener never opens the browser`, async () => {
      const ports = fakePorts({ registerFails });
      const { outcomes } = start(ports);
      await flush();
      await flush();
      expect(outcomes).toEqual([{ kind: "browser-unavailable" }]);
      expect(ports.events.some((event) => event.startsWith("open:"))).toBe(false);
      expect(ports.listeners()).toBe(0);
    });
  }

  test("cancel before the listeners land: no browser, no outcome, nothing left listening", async () => {
    let release!: () => void;
    const ports = fakePorts({ holdRegistration: new Promise<void>((resolve) => { release = resolve; }) });
    const { attempt, outcomes } = start(ports);
    attempt.cancel();
    release();
    await flush();
    await flush();
    expect(outcomes).toEqual([]);
    expect(ports.events.some((event) => event.startsWith("open:"))).toBe(false);
    expect(ports.listeners()).toBe(0);
  });

  test("cancel while the browser is still opening: it is closed again once it is up", async () => {
    let presented!: () => void;
    const ports = fakePorts({ holdOpen: new Promise<void>((resolve) => { presented = resolve; }) });
    const { attempt, outcomes } = start(ports);
    await flush();
    expect(ports.events.some((event) => event.startsWith("open:"))).toBe(true);
    attempt.cancel();
    expect(ports.closeCalls).toBe(1); // too early on Android: nothing presented yet
    presented();
    await flush();
    await flush();
    expect(ports.closeCalls).toBe(2);
    expect(outcomes).toEqual([]);
  });

  test("cancel while waiting: listeners removed, browser dismissed, a later return is ignored", async () => {
    const ports = fakePorts();
    const { attempt, outcomes } = start(ports);
    await flush();
    attempt.cancel();
    attempt.cancel();
    expect(ports.listeners()).toBe(0);
    expect(ports.closeCalls).toBe(1);
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    expect(outcomes).toEqual([]);
  });

  test("a dismissal iOS refuses (nothing presented) is swallowed", async () => {
    const ports = fakePorts({ closeRejects: true });
    const { outcomes } = start(ports);
    await flush();
    ports.openUrl(returnUrl({ code: CODE, state: STATE }));
    await flush();
    expect(outcomes).toEqual([{ kind: "code", code: CODE }]);
  });
});

// ── One protocol, four places ────────────────────────────────────────
//
// The deep link is spelled in the backend (where it redirects), here (where it is
// accepted), the Android manifest and the iOS Info.plist (where the OS routes it).
// A drift in any one is a flow that silently never returns.

describe("the native return is spelled the same everywhere", () => {
  const repo = join(import.meta.dir, "../../../..");
  const readRepo = (path: string) => readFileSync(join(repo, path), "utf8");

  test("the backend redirects to this module's constants", () => {
    const backend = readRepo("backend/src/routes/google-oauth.ts");
    expect(backend).toContain(`NATIVE_OAUTH_RETURN_URL = "${NATIVE_OAUTH_RETURN_URL}"`);
    expect(backend).toContain(`NATIVE_OAUTH_CLIENT = "${NATIVE_OAUTH_STATE_PREFIX.slice(0, -1)}"`);
    expect(backend).toContain(`NATIVE_OAUTH_NOT_COMPLETED = "${NATIVE_OAUTH_NOT_COMPLETED}"`);
  });

  test("Android routes the scheme, host and path to MainActivity", () => {
    const manifest = readRepo("mobile/android/app/src/main/AndroidManifest.xml");
    expect(manifest).toContain('android:scheme="xyz.tinycloud.exo"');
    expect(manifest).toContain('android:host="oauth"');
    expect(manifest).toContain('android:path="/google"');
    expect(manifest).toContain('android:launchMode="singleTask"');
  });

  test("iOS registers the scheme", () => {
    const plist = readRepo("mobile/ios/App/App/Info.plist");
    expect(plist).toContain("<key>CFBundleURLSchemes</key>");
    expect(plist).toContain("<string>xyz.tinycloud.exo</string>");
  });

  test("the deep link's scheme is the app id", () => {
    const config = readRepo("mobile/capacitor.config.ts");
    expect(config).toContain('appId: "xyz.tinycloud.exo"');
    expect(NATIVE_OAUTH_RETURN_URL.startsWith("xyz.tinycloud.exo://")).toBe(true);
  });
});

describe("nativeGoogleOAuthEnabled", () => {
  test("off unless the build sets exactly \"true\" (the private-use return needs a claimed https link first)", () => {
    expect(nativeGoogleOAuthEnabled({})).toBe(false);
    expect(nativeGoogleOAuthEnabled({ VITE_EXO_NATIVE_GOOGLE_OAUTH: "1" })).toBe(false);
    expect(nativeGoogleOAuthEnabled({ VITE_EXO_NATIVE_GOOGLE_OAUTH: "true" })).toBe(true);
  });
});
