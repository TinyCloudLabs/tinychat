import { expect, test } from "bun:test";

import { initialRecorderState, recorderReducer } from "./recorderReducer";
import { permissionDeniedAnnouncement } from "./RecorderProvider";

test("microphone denial announces once when permission changes to denied", () => {
  const denied = recorderReducer(initialRecorderState, { type: "PERMISSION_DENIED" });
  expect(permissionDeniedAnnouncement(initialRecorderState.permissionDenied, denied.permissionDenied))
    .toBe("Microphone access is off");
  expect(permissionDeniedAnnouncement(denied.permissionDenied, denied.permissionDenied)).toBeNull();
  const granted = recorderReducer(denied, { type: "PERMISSION_GRANTED" });
  expect(permissionDeniedAnnouncement(denied.permissionDenied, granted.permissionDenied)).toBeNull();
});
