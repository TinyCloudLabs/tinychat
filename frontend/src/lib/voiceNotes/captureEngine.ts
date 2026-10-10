import { nativeVoiceNotesAvailable } from "./nativeVoiceNotes";

/** Single availability seam for the recorder engine. The web/desktop adapters replace this selector. */
export function captureEngineAvailable(): boolean {
  return nativeVoiceNotesAvailable();
}
