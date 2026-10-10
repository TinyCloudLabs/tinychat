export const SYSTEM_AUDIO_NOTICE_KEY = "exo.systemAudioNoticeSeen";

export const SYSTEM_AUDIO_NOTICE_TEXT =
  "System audio is now included in Mac recordings. Turn it off here.";

export const SYSTEM_AUDIO_NOTICE_DISMISS = "Dismiss the system audio notice";

function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Unreadable storage counts as unseen: the notice shows rather than Mac audio being recorded unannounced. */
export function systemAudioNoticeSeen(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(SYSTEM_AUDIO_NOTICE_KEY) === "1";
  } catch (error) {
    console.warn(
      "Could not read whether the system audio notice was seen; showing it",
      error,
    );
    return false;
  }
}

/**
 * Stores that the notice was seen. Storage that is disabled or full keeps it from persisting, never from closing:
 * the caller hides it for this session either way.
 */
export function markSystemAudioNoticeSeen(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(SYSTEM_AUDIO_NOTICE_KEY, "1");
  } catch (error) {
    console.warn(
      "Could not store that the system audio notice was seen; it stays hidden until the app is closed",
      error,
    );
  }
}
