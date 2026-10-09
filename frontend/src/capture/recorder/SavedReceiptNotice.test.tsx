// The receipt's informational line for a saved recording that is missing some audio.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FINALIZATION_PENDING } from "./recorderCopy";
import { receiptPartialNotice } from "./final/honestRecorderError";
import { voiceNoteRoute } from "./RouteLine";
import { SavedReceipt } from "./SavedReceipt";
import type { RecorderCaptureIssue } from "./recorderReducer";

const noop = () => {};
const partial: RecorderCaptureIssue = { kind: "partial_audio", missingMs: 12_000 };

function receipt(patch: { error?: string | null; issues?: Record<string, RecorderCaptureIssue>; pendingId?: string | null } = {}) {
  const source = {
    error: patch.error ?? null,
    captureIssues: patch.issues ?? { "rec-1": partial },
    finalizationPendingId: patch.pendingId ?? null,
  };
  return renderToStaticMarkup(
    <SavedReceipt
      outcome="saved"
      saved={{ id: "rec-1", durationMs: 65_000, at: Date.UTC(2026, 9, 9, 9, 41) }}
      route={voiceNoteRoute("off")}
      error={source.error}
      notice={receiptPartialNotice(source, "rec-1")}
      onDone={noop}
      onSaveNow={noop}
    />,
  );
}

describe("SavedReceipt notice", () => {
  test("a recording missing some audio says so under the receipt, as information rather than an alert", () => {
    const html = receipt();
    expect(html).toContain('data-testid="voice-note-partial-audio"');
    expect(html).toContain("Saved — part of this recording couldn&#x27;t be written");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("destructive");
    expect(html).toContain("Saved on this phone");
  });

  test("no notice for a whole recording", () => {
    expect(receipt({ issues: {} })).not.toContain("voice-note-partial-audio");
  });

  test("never beside 'Exo will finish it automatically'", () => {
    const html = receipt({ error: FINALIZATION_PENDING, pendingId: "rec-1" });
    expect(html).toContain("automatically");
    expect(html).not.toContain("voice-note-partial-audio");
    expect(html).not.toContain("part of this recording");
  });
});
