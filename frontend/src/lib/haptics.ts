// Haptic feedback for the recorder (record, saved, a route change), only inside
// the Exo mobile app. Elsewhere, or in a shell built before the plugin was
// added, every call does nothing. Feedback never blocks or fails an action.
import { Capacitor } from "@capacitor/core";
import { Haptics, ImpactStyle, NotificationType } from "@capacitor/haptics";

function available(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Haptics");
}

function quietly(feedback: () => Promise<void>): void {
  if (!available()) return;
  feedback().catch((error: unknown) =>
    console.warn("[Haptics] Feedback failed", error),
  );
}

/** A recording started. */
export function hapticRecordStarted(): void {
  quietly(() => Haptics.impact({ style: ImpactStyle.Medium }));
}

/** A recording landed in the user's space. */
export function hapticSaved(): void {
  quietly(() => Haptics.notification({ type: NotificationType.Success }));
}

/** A recording could not be saved (it stays on the phone). */
export function hapticWarning(): void {
  quietly(() => Haptics.notification({ type: NotificationType.Warning }));
}

/** A segment of a control changed. */
export function hapticSelection(): void {
  quietly(() => Haptics.selectionChanged());
}

/** A light tap: pause, resume, a mode change. */
export function hapticLight(): void {
  quietly(() => Haptics.impact({ style: ImpactStyle.Light }));
}

/** A firm tap: Done, discard. */
export function hapticMedium(): void {
  quietly(() => Haptics.impact({ style: ImpactStyle.Medium }));
}
