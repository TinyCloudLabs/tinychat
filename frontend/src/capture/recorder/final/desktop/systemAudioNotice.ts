export const SYSTEM_AUDIO_NOTICE_KEY = "exo.systemAudioNoticeSeen";

export const SYSTEM_AUDIO_NOTICE_TEXT =
  "System audio is now included in Mac recordings. Turn it off here.";

export const SYSTEM_AUDIO_NOTICE_DISMISS = "Dismiss the system audio notice";

export function systemAudioNoticeSeen(
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean {
  return storage.getItem(SYSTEM_AUDIO_NOTICE_KEY) === "1";
}

export function markSystemAudioNoticeSeen(
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  storage.setItem(SYSTEM_AUDIO_NOTICE_KEY, "1");
}
