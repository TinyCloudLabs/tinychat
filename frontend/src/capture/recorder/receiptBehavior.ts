import type { RecorderState } from "./recorderReducer";

/** An auto-stop receipt waits for the moment field to blur so its draft commits first. */
export function shouldScheduleReceiptDismissal(
  state: Pick<RecorderState, "limitNotice">,
  momentFieldFocused: boolean,
): boolean {
  return state.limitNotice === null || !momentFieldFocused;
}
