import type { RecorderState } from "./recorderReducer";

/** An auto-stop receipt waits for the moment field to blur so its draft commits first. */
export function shouldScheduleReceiptDismissal(
  state: Pick<RecorderState, "limitNotice">,
  momentFieldFocused: boolean,
): boolean {
  return state.limitNotice === null || !momentFieldFocused;
}

/**
 * The recording whose own page a receipt closing by itself hands over to, or null. On the Mac the receipt stands where
 * the recorder view stood, over whatever screen the recording began on (often Feed); closing it there would end Stop on
 * that screen. So the recording's page takes the receipt's place. A phone's receipt is a sheet over the screen the user
 * is on, and goes back to it; a receipt that is not on screen moves nobody.
 */
export function noteAfterReceipt(platform: string, receiptShown: boolean, savedId: string | null): string | null {
  return platform === "tauri" && receiptShown ? savedId : null;
}
