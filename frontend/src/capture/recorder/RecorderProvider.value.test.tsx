// RecorderValue exposes recordingId and failedRecording straight from RecorderState, so error text can be matched to its recording.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider, useRecorder, type RecorderValue } from "./RecorderProvider";

function read(value?: Partial<RecorderValue>) {
  let seen: Pick<RecorderValue, "recordingId" | "failedRecording"> | null = null;
  function Probe() {
    const { recordingId, failedRecording } = useRecorder();
    seen = { recordingId, failedRecording };
    return null;
  }
  renderToStaticMarkup(
    <StaticRecorderProvider value={value}>
      <Probe />
    </StaticRecorderProvider>,
  );
  return seen;
}

test("both ids are null when nothing is recording or failed", () => {
  expect(read()).toEqual({ recordingId: null, failedRecording: null });
});

test("both ids are passed through as the reducer holds them", () => {
  expect(read({ recordingId: "a", failedRecording: { id: "b", durationMs: 4000 } })).toEqual({
    recordingId: "a",
    failedRecording: { id: "b", durationMs: 4000 },
  });
});
