import { useCallback, useEffect, useState } from "react";
import {
  OnDeviceStt,
  type OnDeviceSttStatus,
} from "@/lib/voiceNotes/onDeviceStt";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import {
  MODE_STOPS,
  scaleStops,
  type ModeId,
  type ModeShell,
  type ModeStop,
} from "./transcriptionModes";
import type { RecorderValue } from "../RecorderProvider";
import type { SetTranscriberResult } from "../voiceNoteRecorderController";

export type TranscriberApi = Pick<
  RecorderValue,
  "transcriber" | "setTranscriber" | "setIdentifySpeakers"
>;
export const PRIVATE_UNAVAILABLE = "Not available right now";
export const SIGNED_OUT = "Sign in to choose another mode";
export const unavailableNow = (what: string) =>
  `${what} isn't available right now`;
export const SPEAKERS_NEEDS_CONSENT = "Turn on private transcription first";

export const TRANSCRIBER_FOR: Record<ModeId, TranscriberId> = {
  skip: "off",
  local: "on-device",
  private: "private-cloud",
  powerful: "assemblyai",
};
const MODE_NAME = Object.fromEntries(
  MODE_STOPS.map((stop) => [stop.id, stop.shortName]),
) as Record<ModeId, string>;
const MODE_FOR = Object.fromEntries(
  Object.entries(TRANSCRIBER_FOR).map(([mode, id]) => [id, mode]),
) as Record<TranscriberId, ModeId>;

export interface ScaleStop {
  stop: ModeStop;
  available: boolean;
  reason?: string;
}

/**
 * The on-device model, as the Local stop needs it. `model` is null on a build
 * without the plugin. A failed probe or listener is logged and handed back as
 * `error`, with `retry` to try again; Local stays unavailable meanwhile.
 */
export function useOnDeviceModel(): {
  model: OnDeviceSttStatus | null;
  error: string | null;
  retry: () => void;
} {
  const [model, setModel] = useState<OnDeviceSttStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!captureCapabilities().localTranscription) return;
    let live = true;
    const failed = (what: string) => (caught: unknown) => {
      console.error(`[Recorder] Could not ${what}`, caught);
      if (live)
        setError(
          `Could not ${what}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
    };
    const succeeded = (next: OnDeviceSttStatus) => {
      if (!live) return;
      setModel(next);
      setError(null);
    };
    OnDeviceStt.status().then(succeeded, failed("check the on-device model"));
    const handle = OnDeviceStt.addListener("status", succeeded);
    handle.catch(failed("follow the on-device model"));
    return () => {
      live = false;
      handle
        .then((h) => h.remove())
        .catch((caught: unknown) =>
          console.error(
            "[Recorder] Could not stop following the on-device model",
            caught,
          ),
        );
    };
  }, [attempt]);
  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);
  return { model, error, retry };
}

export interface TranscriptionChoiceOptions {
  shell: ModeShell;
  transcription: VoiceNoteTranscriptionProps | undefined;
  model: OnDeviceSttStatus | null;
  transcriber: TranscriberApi;
  /** The account's current state: signed out, the provider is locked to Local. */
  signedIn: boolean;
  /** Tells the user something that did not work. */
  notify: (message: string) => void;
}

/**
 * The privacy scale's state. The mode shown is always the provider's
 * `transcriber.id`: a choice is a request to the provider for this recording,
 * and the scale moves only when the provider says so. Private asks for the
 * one-time consent when the provider says it needs it, then asks again.
 */
export function useTranscriptionChoice({
  shell,
  transcription,
  model,
  transcriber: api,
  signedIn,
  notify,
}: TranscriptionChoiceOptions) {
  const offered = transcription?.availability === "available";
  const consented = transcription?.consented ?? false;
  const mode = MODE_FOR[api.transcriber.id];

  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<ModeId | null>(null);
  const [retry, setRetry] = useState<ModeId | null>(null);

  const stops: ScaleStop[] = scaleStops(shell, model).map(
    ({ availability, ...stop }) => {
      if (!signedIn && stop.id !== "local")
        return { stop, available: false, reason: SIGNED_OUT };
      if (!signedIn) return { stop, available: true };
      if (stop.id === "private" && !offered)
        return { stop, available: false, reason: PRIVATE_UNAVAILABLE };
      return availability.available
        ? { stop, available: true }
        : { stop, available: false, reason: availability.reason };
    },
  );

  const failed = (what: string, caught: unknown) => {
    console.error(`[Recorder] Could not ${what}`, caught);
    notify(
      `Could not ${what}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  };

  const request = async (id: ModeId) => {
    let result: SetTranscriberResult;
    try {
      result = await api.setTranscriber(TRANSCRIBER_FOR[id], {
        scope: "recording",
      });
    } catch (caught) {
      failed("change the transcription mode", caught);
      return;
    }
    switch (result) {
      case "ok":
        return;
      case "needs_consent":
        setPending(id);
        setAsking(true);
        return;
      case "locked_signed_out":
        notify(SIGNED_OUT);
        return;
      case "unavailable":
        console.error(
          `[Recorder] The provider cannot use ${TRANSCRIBER_FOR[id]} right now`,
        );
        notify(unavailableNow(MODE_NAME[id]));
        return;
    }
  };

  // Consent is given through the existing route; the request is repeated once the route reports it.
  useEffect(() => {
    if (retry === null || !consented) return;
    setRetry(null);
    void request(retry);
  }, [retry, consented]);

  /** Returns why a stop cannot be chosen, or null when the request was sent. */
  const select = (id: ModeId): string | null => {
    const stop = stops.find((s) => s.stop.id === id);
    if (!stop) throw new Error(`Unknown transcription mode: ${id}`);
    if (!stop.available) return stop.reason ?? "Not available";
    if (id !== mode) void request(id);
    return null;
  };

  /** The next available stop either way; the ends stay put. */
  const step = (direction: -1 | 1): ModeId => {
    const available = stops.filter((s) => s.available);
    if (!available.length) return mode;
    const at = available.findIndex((s) => s.stop.id === mode);
    const next =
      at < 0
        ? direction > 0
          ? 0
          : available.length - 1
        : Math.max(0, Math.min(available.length - 1, at + direction));
    return available[next]!.stop.id;
  };

  const confirmConsent = () => {
    transcription?.onConsent();
    setAsking(false);
    setRetry(pending);
    setPending(null);
  };

  const dismissConsent = () => {
    setAsking(false);
    setPending(null);
  };

  const setIdentifySpeakers = async (enabled: boolean) => {
    let result: SetTranscriberResult;
    try {
      result = await api.setIdentifySpeakers(enabled, "recording");
    } catch (caught) {
      failed("change Identify speakers", caught);
      return;
    }
    if (result === "ok") return;
    // The switch shows the provider's value, so a refusal leaves it where it was.
    console.error(`[Recorder] Identify speakers was refused: ${result}`);
    notify(
      result === "needs_consent"
        ? SPEAKERS_NEEDS_CONSENT
        : result === "locked_signed_out"
          ? SIGNED_OUT
          : unavailableNow("Identify speakers"),
    );
  };

  return {
    mode,
    stops,
    select,
    step,
    identifySpeakers: api.transcriber.identifySpeakers,
    setIdentifySpeakers,
    asking,
    dismissConsent,
    confirmConsent,
    maxMinutes: Math.round((transcription?.maxSeconds ?? 0) / 60),
  };
}
