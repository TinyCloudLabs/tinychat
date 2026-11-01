// TC-2081: a Private note whose recording is past the limit is saved and kept; the pipeline says so and offers no retry.
import { describe, expect, test } from "bun:test";

import { notePipeline, type NotePipelineInput } from "./notePipeline";

const NEW_SENTENCE = "Your recording is saved, but it's too long for private transcription. The audio is kept, so nothing is lost.";

function pipeline(transcriptProvider?: NotePipelineInput["transcriptProvider"]) {
  return notePipeline({
    device: "phone",
    route: "private-cloud",
    ...(transcriptProvider ? { transcriptProvider } : {}),
    hasNotesOrMoments: false,
    online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: true, pending: null },
    transcript: { inSpace: null, onDevice: null, cloud: { kind: "blocked", reason: "limits-exceeded" } },
    notes: { state: "idle" },
  });
}

describe("a Private note past the limit (blocked: limits-exceeded)", () => {
  test("the cause is the new sentence and there is no action, because the note will never fit", () => {
    const result = pipeline("private");
    const step = result.steps.find((s) => s.key === "transcript");
    expect(step?.state).toBe("blocked");
    expect(step?.blocker).toEqual({ cause: NEW_SENTENCE });
    expect(step?.blocker?.action).toBeUndefined();
    expect(result.blocker?.cause).toBe(NEW_SENTENCE);
    expect(result.blocker?.action).toBeUndefined();
  });

  test("the default provider is Private and behaves the same", () => {
    expect(pipeline().blocker).toEqual({ cause: NEW_SENTENCE });
  });

  test("the sentence offers no retry wording", () => {
    expect(NEW_SENTENCE).not.toMatch(/\b(?:retry|try again|check again)\b/i);
  });

  test("other providers keep their own text and the Check again action", () => {
    expect(pipeline("powerful").blocker).toMatchObject({
      cause: "Powerful couldn't accept this recording's length or size.", action: { kind: "check-again" },
    });
    expect(pipeline("unknown").blocker).toMatchObject({
      cause: "transcription couldn't accept this recording's length or size.", action: { kind: "check-again" },
    });
  });
});
