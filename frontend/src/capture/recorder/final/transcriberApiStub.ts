import { useRef, useState } from "react";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";

// TODO(TC-781 transcriber API): this file stands in for the provider's transcriber API (stacked on #186).
// When it lands, delete this file, take `TranscriberId` (which gains "off") from nativeVoiceNotes, and
// have PhoneRecorder read `transcriber`, `setTranscriber` and `setIdentifySpeakers` from `useRecorder()`.

export type RecorderTranscriberId = TranscriberId | "off";
export type TranscriberScope = "recording" | "default";
export type SetTranscriberResult =
  | "ok"
  | "needs_consent"
  | "locked_signed_out"
  | "unavailable";

export interface RecorderTranscriber {
  id: RecorderTranscriberId;
  identifySpeakers: boolean;
  /** A live recording reads its own session options; otherwise this is the effective default. */
  source: "recording" | "default";
}

export interface TranscriberApi {
  transcriber: RecorderTranscriber;
  setTranscriber(
    id: RecorderTranscriberId,
    options: { scope: TranscriberScope },
  ): SetTranscriberResult | Promise<SetTranscriberResult>;
  setIdentifySpeakers(
    on: boolean,
    scope: TranscriberScope,
  ): SetTranscriberResult | Promise<SetTranscriberResult>;
}

/** The API over this screen's own state, with the consent the existing private-cloud route holds. */
export function useTranscriberApi(
  transcription: VoiceNoteTranscriptionProps | undefined,
): TranscriberApi {
  const [transcriber, setState] = useState<RecorderTranscriber>({
    id: transcription?.consented ? "private-cloud" : "on-device",
    identifySpeakers: false,
    source: "recording",
  });
  const latest = useRef(transcription);
  latest.current = transcription;
  return {
    transcriber,
    setTranscriber: (id) => {
      if (id === "assemblyai") return "unavailable";
      if (id === "private-cloud" && !latest.current?.consented)
        return "needs_consent";
      setState((current) => ({ ...current, id }));
      return "ok";
    },
    setIdentifySpeakers: (on) => {
      setState((current) => ({ ...current, identifySpeakers: on }));
      return "ok";
    },
  };
}
