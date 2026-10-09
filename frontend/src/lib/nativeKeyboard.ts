// The native keyboard plugin (@capacitor/keyboard), loaded lazily and only inside the iOS app.
//
// Once it loads, the plugin hides the keyboard's accessory bar on every field (its `load` swizzles it off). So the
// shell restores the bar at boot (`restoreAccessoryBar`) and only the notes sheet and the moment field hide it, while
// they are open (`holdAccessoryBarHidden`). The bar exists on iOS only; Android's `setAccessoryBarVisible` is
// unimplemented, so nothing runs there, on the web or on the desktop.
import { Capacitor } from "@capacitor/core";

/** The part of `Keyboard` this app uses. */
export interface KeyboardPluginLike {
  setAccessoryBarVisible(options: { isVisible: boolean }): Promise<void>;
}

export interface NativeKeyboardEnv {
  /** "ios" only inside the iOS app; anything else (web, desktop, Android) does nothing here. */
  platform(): string;
  load(): Promise<KeyboardPluginLike>;
}

export interface NativeKeyboard {
  /** Puts the accessory bar back; the shell calls it once at boot, before any field can be focused. */
  restoreAccessoryBar(): Promise<void>;
  /** Hides the accessory bar until the returned release is called (holds add up: it is back when none is left). */
  holdAccessoryBarHidden(): () => void;
}

export function createNativeKeyboard(env: NativeKeyboardEnv): NativeKeyboard {
  const active = env.platform() === "ios";
  let plugin: Promise<KeyboardPluginLike> | null = null;
  const load = () => (plugin ??= env.load());

  let holds = 0;
  let hidden = false;
  let queue: Promise<void> = Promise.resolve();
  const apply = () => {
    queue = queue.then(async () => {
      const wantHidden = holds > 0;
      if (wantHidden === hidden) return;
      try {
        const keyboard = await load();
        await keyboard.setAccessoryBarVisible({ isVisible: !wantHidden });
        hidden = wantHidden;
      } catch (error) {
        console.error(
          `[Keyboard] Could not ${wantHidden ? "hide" : "restore"} the accessory bar`,
          error,
        );
      }
    });
  };

  return {
    async restoreAccessoryBar() {
      if (!active) return;
      const keyboard = await load();
      await keyboard.setAccessoryBarVisible({ isVisible: true });
    },
    holdAccessoryBarHidden() {
      if (!active) return () => {};
      holds += 1;
      apply();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        apply();
      };
    },
  };
}

export const nativeKeyboard = createNativeKeyboard({
  platform: () => (Capacitor.isNativePlatform() ? Capacitor.getPlatform() : "web"),
  load: async () => {
    const { Keyboard } = await import("@capacitor/keyboard");
    // Not `return Keyboard`: resolving a promise with a Capacitor plugin proxy reads its `then`, which the bridge sends
    // to native as a call that never answers, so the load would hang.
    return { setAccessoryBarVisible: (options) => Keyboard.setAccessoryBarVisible(options) };
  },
});
