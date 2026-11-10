// The app lock (TC-2738). In the phone app, a signed-in TinyCloud Home asks for
// Face ID / Touch ID (or the device passcode; Android: BiometricPrompt with the
// screen lock as fallback) when it opens cold, and when it returns after more
// than a few minutes in the background. It replaces re-authenticating at
// startup: the session never leaves the device, so unlocking only has to prove
// the person holding the phone is its owner.
//
// The lock hides; it doesn't block. The app mounts, reads its local data and
// starts its network refresh behind the lock screen, so everything is already
// on screen the instant the unlock succeeds. A cancelled or failed unlock keeps
// the lock screen up with Retry; nothing here ever signs anyone out.
//
// The native plugin (AppLockPlugin.swift / AppLockPlugin.java) measures time in
// the background and covers the window while backgrounded, so the app switcher
// shows no data (iOS, and Android 13+); every decision is made here.
import { useSyncExternalStore } from "react";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { appPlatform } from "./platform";
import { nativeSessionWasActive, onNativeSessionChange } from "./openkeyNative";

// ── State machine (pure) ─────────────────────────────────────────────

export type UnlockResult = "success" | "cancelled" | "failed" | "unavailable";

export interface LockState {
  locked: boolean;
  authenticating: boolean;
  /** Why the last attempt didn't unlock, for the lock screen. */
  failure: "cancelled" | "failed" | null;
}

export type LockEvent =
  /** Cold launch: lock if the lock applies (signed in, turned on). */
  | { type: "launch"; required: boolean }
  /** Back from the background, after `backgroundMs` there. */
  | { type: "foreground"; backgroundMs: number; required: boolean; timeoutMs: number }
  | { type: "authStart" }
  | { type: "authResult"; result: UnlockResult }
  /** The lock no longer applies: turned off, signed out, or the device has no screen lock to ask for. */
  | { type: "release" };

export const UNLOCKED: LockState = { locked: false, authenticating: false, failure: null };

export function reduceLock(state: LockState, event: LockEvent): LockState {
  switch (event.type) {
    case "launch":
      return event.required ? { locked: true, authenticating: false, failure: null } : UNLOCKED;
    case "foreground":
      // The system unlock sheet can itself take the app through the background (Android's PIN screen).
      if (state.authenticating || state.locked) return state;
      return event.required && event.backgroundMs >= event.timeoutMs
        ? { locked: true, authenticating: false, failure: null }
        : state;
    case "authStart":
      return state.locked && !state.authenticating ? { ...state, authenticating: true, failure: null } : state;
    case "authResult":
      if (!state.authenticating) return state;
      // No passcode means nothing to ask for: the lock can't apply, so it opens.
      if (event.result === "success" || event.result === "unavailable") return UNLOCKED;
      return { locked: true, authenticating: false, failure: event.result };
    case "release":
      return UNLOCKED;
  }
}

// ── Preferences (this device only) ───────────────────────────────────

export const APP_LOCK_PREFS_KEY = "xyz.tinycloud.home:app-lock";
export const LOCK_TIMEOUT_MINUTES = [1, 5, 15, 60] as const;
export type LockTimeoutMinutes = (typeof LOCK_TIMEOUT_MINUTES)[number];
export const DEFAULT_LOCK_TIMEOUT_MINUTES: LockTimeoutMinutes = 5;

export interface AppLockPrefs {
  /** null until decided: a new install turns the lock on if the device has biometrics enrolled. */
  enabled: boolean | null;
  timeoutMinutes: LockTimeoutMinutes;
}

type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

export function readPrefs(storage: PrefsStorage | null): AppLockPrefs {
  let parsed: Partial<AppLockPrefs> = {};
  try {
    const raw = storage?.getItem(APP_LOCK_PREFS_KEY);
    if (raw) parsed = JSON.parse(raw) as Partial<AppLockPrefs>;
  } catch {
    // Unreadable: the defaults.
  }
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : null,
    timeoutMinutes: LOCK_TIMEOUT_MINUTES.includes(parsed.timeoutMinutes as LockTimeoutMinutes)
      ? parsed.timeoutMinutes as LockTimeoutMinutes : DEFAULT_LOCK_TIMEOUT_MINUTES,
  };
}

function writePrefs(storage: PrefsStorage | null, prefs: AppLockPrefs): void {
  try {
    storage?.setItem(APP_LOCK_PREFS_KEY, JSON.stringify(prefs));
  } catch (error) {
    console.warn("Could not store the app lock setting; it applies until the app is closed", error);
  }
}

// ── Native plugin ────────────────────────────────────────────────────

export type Biometry = "faceID" | "touchID" | "opticID" | "biometric" | "none";

export interface DeviceAuthStatus {
  biometry: Biometry;
  biometryEnrolled: boolean;
  /** A passcode / screen lock is set: device-owner authentication can be asked for. */
  deviceSecure: boolean;
}

export interface AppLockNative {
  status(): Promise<DeviceAuthStatus>;
  authenticate(options: { reason: string }): Promise<{ result: UnlockResult }>;
  setCover(options: { enabled: boolean }): Promise<void>;
  reveal(): Promise<void>;
  addListener(event: "foreground", listener: (event: { backgroundMs: number }) => void): Promise<PluginListenerHandle>;
}

/** What to call the unlock on this device, as in "Unlock with Face ID". */
export function biometryName(status: DeviceAuthStatus | null): string {
  switch (status?.biometryEnrolled ? status.biometry : "none") {
    case "faceID": return "Face ID";
    case "touchID": return "Touch ID";
    case "opticID": return "Optic ID";
    case "biometric": return "biometrics";
    default: return appPlatform() === "android" ? "screen lock" : "passcode";
  }
}

// ── Controller ───────────────────────────────────────────────────────

export interface AppLockDeps {
  native: AppLockNative | null;
  storage: PrefsStorage | null;
  signedIn: boolean;
  /** Runs once the lock decision has painted, to drop the native background cover. */
  afterPaint: (callback: () => void) => void;
}

export interface AppLockSnapshot {
  state: LockState;
  prefs: AppLockPrefs;
  device: DeviceAuthStatus | null;
  /** The lock applies on this device: the phone app with the native plugin. */
  supported: boolean;
}

export interface AppLock {
  subscribe(listener: () => void): () => void;
  getSnapshot(): AppLockSnapshot;
  /** Resolves when the app is unlocked (at once if it is). */
  unlocked(): Promise<void>;
  /** Reads the device's authentication, settles the default, listens for returns from the background. */
  start(): Promise<void>;
  /** Asks for Face ID / the passcode again (the lock screen's button). */
  retry(): Promise<void>;
  setSignedIn(signedIn: boolean): void;
  setEnabled(enabled: boolean): void;
  setTimeoutMinutes(minutes: LockTimeoutMinutes): void;
}

export function createAppLock(deps: AppLockDeps): AppLock {
  const { native, storage } = deps;
  let signedIn = deps.signedIn;
  let device: DeviceAuthStatus | null = null;
  let prefs = readPrefs(storage);
  // Locked from the first render on a cold launch: until the device answers, assume the lock applies.
  let snapshot: AppLockSnapshot = {
    state: reduceLock(UNLOCKED, { type: "launch", required: !!native && signedIn && prefs.enabled !== false }),
    prefs, device, supported: !!native,
  };
  const listeners = new Set<() => void>();
  let unlockWaiters: Array<() => void> = [];
  let started = false;
  let coverEnabled: boolean | null = null;

  const required = () => !!native && signedIn && prefs.enabled === true && device?.deviceSecure === true;

  function publish(state: LockState) {
    if (state === snapshot.state && prefs === snapshot.prefs && device === snapshot.device) return;
    snapshot = { state, prefs, device, supported: !!native };
    if (!state.locked) {
      const waiters = unlockWaiters;
      unlockWaiters = [];
      for (const resolve of waiters) resolve();
    }
    syncCover();
    for (const listener of listeners) listener();
  }

  function dispatch(event: LockEvent) {
    publish(reduceLock(snapshot.state, event));
  }

  function syncCover() {
    if (!native || device === null) return;
    const enabled = required();
    if (enabled === coverEnabled) return;
    coverEnabled = enabled;
    void native.setCover({ enabled }).catch(() => {});
  }

  async function authenticate(): Promise<void> {
    if (!native || !snapshot.state.locked || snapshot.state.authenticating) return;
    dispatch({ type: "authStart" });
    let result: UnlockResult;
    try {
      ({ result } = await native.authenticate({ reason: "Unlock TinyCloud Home" }));
    } catch {
      result = "failed";
    }
    dispatch({ type: "authResult", result });
  }

  function onForeground(backgroundMs: number) {
    dispatch({ type: "foreground", backgroundMs, required: required(), timeoutMs: prefs.timeoutMinutes * 60_000 });
    // Drop the native cover once the lock screen (or the unlocked app) is what's painted.
    deps.afterPaint(() => { void native?.reveal().catch(() => {}); });
    if (snapshot.state.locked) void authenticate();
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
    unlocked() {
      // Not Promise.withResolvers: newer than this project's lib target and some Android WebViews.
      return snapshot.state.locked ? new Promise((resolve) => { unlockWaiters.push(resolve); }) : Promise.resolve();
    },
    async start() {
      if (!native || started) return;
      started = true;
      await native.addListener("foreground", ({ backgroundMs }) => onForeground(backgroundMs));
      try {
        device = await native.status();
      } catch {
        device = { biometry: "none", biometryEnrolled: false, deviceSecure: false };
      }
      if (prefs.enabled === null) {
        prefs = { ...prefs, enabled: device.biometryEnrolled };
        writePrefs(storage, prefs);
      }
      if (!required()) dispatch({ type: "release" });
      else publish(snapshot.state);
      // A cover left from before a WebView reload.
      void native.reveal().catch(() => {});
      if (snapshot.state.locked) await authenticate();
    },
    retry: authenticate,
    setSignedIn(next: boolean) {
      if (next === signedIn) return;
      signedIn = next;
      // Signing out leaves nothing to protect. Signing in is itself an authentication, so it never locks.
      if (!next) dispatch({ type: "release" });
      syncCover();
    },
    setEnabled(enabled: boolean) {
      prefs = { ...prefs, enabled };
      writePrefs(storage, prefs);
      if (!enabled) dispatch({ type: "release" });
      else publish(snapshot.state);
    },
    setTimeoutMinutes(timeoutMinutes: LockTimeoutMinutes) {
      prefs = { ...prefs, timeoutMinutes };
      writePrefs(storage, prefs);
      publish(snapshot.state);
    },
  };
}

// ── The app's instance ───────────────────────────────────────────────

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function nativeAppLock(): AppLockNative | null {
  const platform = appPlatform();
  if ((platform !== "ios" && platform !== "android") || !Capacitor.isPluginAvailable("AppLock")) return null;
  return registerPlugin<AppLockNative>("AppLock");
}

let instance: AppLock | null = null;

export function appLock(): AppLock {
  if (!instance) {
    instance = createAppLock({
      native: nativeAppLock(),
      storage: browserStorage(),
      signedIn: nativeSessionWasActive(),
      afterPaint: (callback) => requestAnimationFrame(() => requestAnimationFrame(callback)),
    });
    onNativeSessionChange((active) => instance?.setSignedIn(active));
  }
  return instance;
}

export function useAppLock(lock: AppLock = appLock()): AppLockSnapshot {
  return useSyncExternalStore(lock.subscribe, lock.getSnapshot);
}

/** False while the lock screen is up. Always true on the web and desktop. */
export function useAppUnlocked(): boolean {
  return !useAppLock().state.locked;
}

/** For code outside React: resolves once the app is unlocked. */
export function appUnlocked(): Promise<void> {
  return appLock().unlocked();
}
