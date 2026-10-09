// RecorderValue exposes recordingId, failedRecording and finalizationPendingId straight from RecorderState, so error text can be matched to its recording.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider, recordingIdentity, useRecorder, type RecorderValue } from "./RecorderProvider";
import { initialRecorderState } from "./recorderReducer";

function read(value?: Partial<RecorderValue>) {
  let seen: Pick<RecorderValue, "recordingId" | "failedRecording" | "finalizationPendingId"> | null = null;
  function Probe() {
    const { recordingId, failedRecording, finalizationPendingId } = useRecorder();
    seen = { recordingId, failedRecording, finalizationPendingId };
    return null;
  }
  renderToStaticMarkup(
    <StaticRecorderProvider value={value}>
      <Probe />
    </StaticRecorderProvider>,
  );
  return seen;
}

test("all three ids are null when nothing is recording or failed", () => {
  expect(read()).toEqual({ recordingId: null, failedRecording: null, finalizationPendingId: null });
});

test("the static provider passes the ids through", () => {
  expect(read({ recordingId: "a", failedRecording: { id: "b", durationMs: 4000 }, finalizationPendingId: "c" })).toEqual({
    recordingId: "a",
    failedRecording: { id: "b", durationMs: 4000 },
    finalizationPendingId: "c",
  });
});

test("the live provider's mapping exposes each reducer field under its own name", () => {
  const state = {
    ...initialRecorderState,
    recordingId: "rec",
    failedRecording: { id: "failed", durationMs: 7 },
    finalizationPendingId: "pending",
  };
  expect(recordingIdentity(state)).toEqual({
    recordingId: "rec",
    failedRecording: { id: "failed", durationMs: 7 },
    finalizationPendingId: "pending",
  });
});
