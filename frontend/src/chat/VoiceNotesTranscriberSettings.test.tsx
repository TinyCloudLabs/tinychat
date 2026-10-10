import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FINAL_COPY, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import type { TranscriptionAvailability } from "@/lib/voiceNotes/voiceNoteTranscription";
import { PrivateUnavailable, transcriberOptions } from "./VoiceNotesTranscriberSettings";

const noop = () => {};
function transcription(availability: TranscriptionAvailability): VoiceNoteTranscriptionProps {
  return {
    availability,
    consented: false,
    maxSeconds: 3600,
    jobs: new Map(),
    onTranscribe: noop,
    onConsent: noop,
    onTurnOff: noop,
    onRecheck: noop,
  };
}

describe("Settings → Voice notes names and offers", () => {
  test("the options carry the recorder's names", () => {
    const { options } = transcriberOptions(true, transcription("available"));
    expect(options.map((o) => o.label)).toEqual([FINAL_COPY.modes.skipName, FINAL_COPY.modes.localName, FINAL_COPY.modes.privateName]);
    expect(options.map((o) => o.label)).toEqual(["Audio only", "Local", "Private"]);
  });

  test("Private is offered only when signed in and the check says it is available", () => {
    const privateOption = (signedIn: boolean, t: VoiceNoteTranscriptionProps | undefined) =>
      transcriberOptions(signedIn, t).options.find((o) => o.value === "private-cloud");
    expect(privateOption(true, transcription("available"))?.disabled).toBe(false);
    for (const availability of ["checking", "failed", "hidden"] as const) {
      expect(privateOption(true, transcription(availability))?.disabled).toBe(true);
    }
    expect(privateOption(false, transcription("available"))?.disabled).toBe(true);
    expect(privateOption(true, undefined)?.disabled).toBe(true);
  });

  test("a failed check says so and offers Check again", () => {
    const html = renderToStaticMarkup(<PrivateUnavailable signedIn transcription={transcription("failed")} />);
    expect(html).toContain(`${TRANSCRIBER_NAME["private-cloud"]}: Couldn&#x27;t check right now`);
    expect(html).toContain(">Check again<");
  });

  test("checking and unavailable give a reason and no retry", () => {
    const checking = renderToStaticMarkup(<PrivateUnavailable signedIn transcription={transcription("checking")} />);
    expect(checking).toContain("Private: Checking…");
    expect(checking).not.toContain("Check again");
    const hidden = renderToStaticMarkup(<PrivateUnavailable signedIn transcription={transcription("hidden")} />);
    expect(hidden).toContain("Private: Not available right now");
    expect(hidden).not.toContain("Check again");
  });

  test("signed out says why, with no retry", () => {
    const html = renderToStaticMarkup(<PrivateUnavailable signedIn={false} transcription={transcription("failed")} />);
    expect(html).toContain("Private: ");
    expect(html).not.toContain("Check again");
  });
});
