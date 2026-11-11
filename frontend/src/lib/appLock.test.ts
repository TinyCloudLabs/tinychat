import { describe, expect, test } from "bun:test";
import {
  APP_LOCK_PREFS_KEY,
  createAppLock,
  reduceLock,
  UNLOCKED,
  type AppLockNative,
  type DeviceAuthStatus,
  type LockState,
  type UnlockResult,
} from "./appLock";

const FACE_ID: DeviceAuthStatus = { biometry: "faceID", biometryEnrolled: true, deviceSecure: true };
const PASSCODE_ONLY: DeviceAuthStatus = { biometry: "none", biometryEnrolled: false, deviceSecure: true };
const NO_SCREEN_LOCK: DeviceAuthStatus = { biometry: "faceID", biometryEnrolled: false, deviceSecure: false };
const MINUTE = 60_000;

describe("reduceLock", () => {
  const locked: LockState = { locked: true, authenticating: false, failure: null };
  const authenticating: LockState = { locked: true, authenticating: true, failure: null };

  test("a cold launch locks only when the lock applies", () => {
    expect(reduceLock(UNLOCKED, { type: "launch", required: true })).toEqual(locked);
    expect(reduceLock(UNLOCKED, { type: "launch", required: false })).toEqual(UNLOCKED);
  });

  test("returning after the timeout locks; a shorter absence doesn't", () => {
    const back = (backgroundMs: number, required = true) =>
      reduceLock(UNLOCKED, { type: "foreground", backgroundMs, required, timeoutMs: 5 * MINUTE });
    expect(back(5 * MINUTE)).toEqual(locked);
    expect(back(5 * MINUTE - 1)).toBe(UNLOCKED);
    expect(back(60 * MINUTE, false)).toBe(UNLOCKED);
  });

  test("the unlock sheet taking the app through the background doesn't restart it", () => {
    const event = { type: "foreground", backgroundMs: 60 * MINUTE, required: true, timeoutMs: MINUTE } as const;
    expect(reduceLock(authenticating, event)).toBe(authenticating);
  });

  test("cancel and failure keep the lock screen, with the reason; retry clears it", () => {
    const cancelled = reduceLock(authenticating, { type: "authResult", result: "cancelled" });
    expect(cancelled).toEqual({ locked: true, authenticating: false, failure: "cancelled" });
    expect(reduceLock(authenticating, { type: "authResult", result: "failed" }))
      .toEqual({ locked: true, authenticating: false, failure: "failed" });
    expect(reduceLock(cancelled, { type: "authStart" })).toEqual(authenticating);
  });

  test("success unlocks, and so does a device with no screen lock left to ask for", () => {
    expect(reduceLock(authenticating, { type: "authResult", result: "success" })).toBe(UNLOCKED);
    expect(reduceLock(authenticating, { type: "authResult", result: "unavailable" })).toBe(UNLOCKED);
  });

  test("a result with no attempt in flight, or a second start, changes nothing", () => {
    expect(reduceLock(locked, { type: "authResult", result: "success" })).toBe(locked);
    expect(reduceLock(authenticating, { type: "authStart" })).toBe(authenticating);
    expect(reduceLock(UNLOCKED, { type: "authStart" })).toBe(UNLOCKED);
  });

  test("release unlocks from anywhere", () => {
    expect(reduceLock(locked, { type: "release" })).toBe(UNLOCKED);
  });
});

class FakeNative implements AppLockNative {
  results: UnlockResult[] = [];
  authCalls = 0;
  covers: boolean[] = [];
  reveals = 0;
  private foreground: ((event: { backgroundMs: number }) => void) | null = null;
  private pending: Array<(value: { result: UnlockResult }) => void> = [];
  private askWaiters: Array<() => void> = [];

  constructor(public device: DeviceAuthStatus) {}

  async status() { return this.device; }
  authenticate() {
    this.authCalls++;
    for (const resolve of this.askWaiters.splice(0)) resolve();
    const next = this.results.shift();
    if (next) return Promise.resolve({ result: next });
    const { promise, resolve } = Promise.withResolvers<{ result: UnlockResult }>();
    this.pending.push(resolve);
    return promise;
  }
  async setCover({ enabled }: { enabled: boolean }) { this.covers.push(enabled); }
  async reveal() { this.reveals++; }
  async addListener(_event: "foreground", listener: (event: { backgroundMs: number }) => void) {
    this.foreground = listener;
    return { remove: async () => { this.foreground = null; } };
  }
  /** Resolves when the next unlock sheet is asked for. */
  nextAsk() {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.askWaiters.push(resolve);
    return promise;
  }
  /** Settle the unlock sheet that is up. */
  answer(result: UnlockResult) { this.pending.shift()?.(({ result })); }
  returnAfter(backgroundMs: number) { this.foreground?.({ backgroundMs }); }
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => { values[key] = value; },
  };
}

function setup(options: { device?: DeviceAuthStatus; signedIn?: boolean; prefs?: object; native?: boolean } = {}) {
  const native = new FakeNative(options.device ?? FACE_ID);
  const storage = memoryStorage(options.prefs ? { [APP_LOCK_PREFS_KEY]: JSON.stringify(options.prefs) } : {});
  const lock = createAppLock({
    native: options.native === false ? null : native,
    storage,
    signedIn: options.signedIn ?? true,
    afterPaint: (callback) => callback(),
  });
  return { native, storage, lock };
}

describe("createAppLock", () => {
  test("cold launch: locked from the first render, asks for Face ID, opens on success", async () => {
    const { native, storage, lock } = setup();
    expect(lock.getSnapshot().state.locked).toBe(true);
    const opened = lock.unlocked();
    const asked = native.nextAsk();
    void lock.start();
    await asked;
    expect(native.authCalls).toBe(1);
    expect(lock.getSnapshot().state.authenticating).toBe(true);
    // A new install with Face ID enrolled turns the lock on.
    expect(JSON.parse(storage.values[APP_LOCK_PREFS_KEY]!).enabled).toBe(true);
    expect(native.covers).toEqual([true]);
    native.answer("success");
    await opened;
    expect(lock.getSnapshot().state).toEqual(UNLOCKED);
  });

  test("a new install without biometrics leaves the lock off and never prompts", async () => {
    const { native, storage, lock } = setup({ device: PASSCODE_ONLY });
    await lock.start();
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.authCalls).toBe(0);
    expect(JSON.parse(storage.values[APP_LOCK_PREFS_KEY]!).enabled).toBe(false);
    expect(native.covers).toEqual([false]);
  });

  test("the lock turned on still asks for the passcode where there are no biometrics", async () => {
    const { native, lock } = setup({ device: PASSCODE_ONLY, prefs: { enabled: true } });
    native.results.push("success");
    await lock.start();
    expect(native.authCalls).toBe(1);
    expect(lock.getSnapshot().state.locked).toBe(false);
  });

  test("disabled: never locked, never prompts, not even after hours away", async () => {
    const { native, lock } = setup({ prefs: { enabled: false } });
    expect(lock.getSnapshot().state.locked).toBe(false);
    await lock.start();
    native.returnAfter(10 * 60 * MINUTE);
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.authCalls).toBe(0);
  });

  test("signed out, on the web, or with no screen lock on the device: no lock", async () => {
    expect(setup({ signedIn: false }).lock.getSnapshot().state.locked).toBe(false);
    const web = setup({ native: false }).lock;
    expect(web.getSnapshot().state.locked).toBe(false);
    expect(web.getSnapshot().supported).toBe(false);
    const { native, lock } = setup({ device: NO_SCREEN_LOCK, prefs: { enabled: true } });
    await lock.start();
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.authCalls).toBe(0);
  });

  test("cancel keeps the lock screen with Retry; retry unlocks", async () => {
    const { native, lock } = setup({ prefs: { enabled: true } });
    native.results.push("cancelled");
    await lock.start();
    expect(lock.getSnapshot().state).toEqual({ locked: true, authenticating: false, failure: "cancelled" });
    native.results.push("failed");
    await lock.retry();
    expect(lock.getSnapshot().state).toEqual({ locked: true, authenticating: false, failure: "failed" });
    native.results.push("success");
    await lock.retry();
    expect(lock.getSnapshot().state).toEqual(UNLOCKED);
    expect(native.authCalls).toBe(3);
  });

  test("a plugin error counts as a failure, not an unlock", async () => {
    const { native, lock } = setup({ prefs: { enabled: true } });
    native.authenticate = () => Promise.reject(new Error("bridge gone"));
    await lock.start();
    expect(lock.getSnapshot().state).toEqual({ locked: true, authenticating: false, failure: "failed" });
  });

  test("background timeout: locks and prompts after the timeout, not before; drops the cover either way", async () => {
    const { native, lock } = setup({ prefs: { enabled: true } });
    native.results.push("success");
    await lock.start();
    const reveals = native.reveals;
    native.returnAfter(5 * MINUTE - 1);
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.reveals).toBe(reveals + 1);
    native.returnAfter(5 * MINUTE);
    expect(lock.getSnapshot().state.locked).toBe(true);
    expect(native.authCalls).toBe(2);
    expect(native.reveals).toBe(reveals + 2);
    native.answer("success");
    await lock.unlocked();
    expect(lock.getSnapshot().state.locked).toBe(false);
  });

  test("the timeout follows Settings", async () => {
    const { native, storage, lock } = setup({ prefs: { enabled: true } });
    native.results.push("success");
    await lock.start();
    lock.setTimeoutMinutes(1);
    expect(JSON.parse(storage.values[APP_LOCK_PREFS_KEY]!).timeoutMinutes).toBe(1);
    native.returnAfter(MINUTE);
    expect(lock.getSnapshot().state.locked).toBe(true);
  });

  test("turning the lock off releases it and the background cover", async () => {
    const { native, lock } = setup({ prefs: { enabled: true } });
    native.results.push("success");
    await lock.start();
    lock.setEnabled(false);
    expect(native.covers).toEqual([true, false]);
    native.returnAfter(60 * MINUTE);
    expect(lock.getSnapshot().state.locked).toBe(false);
  });

  test("signing out releases the lock; signing in never locks", async () => {
    const { native, lock } = setup({ prefs: { enabled: true } });
    const asked = native.nextAsk();
    void lock.start();
    await asked;
    expect(lock.getSnapshot().state.locked).toBe(true);
    lock.setSignedIn(false);
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.covers).toEqual([true, false]);
    native.returnAfter(60 * MINUTE);
    expect(lock.getSnapshot().state.locked).toBe(false);
    lock.setSignedIn(true);
    expect(lock.getSnapshot().state.locked).toBe(false);
    expect(native.covers).toEqual([true, false, true]);
  });
});
