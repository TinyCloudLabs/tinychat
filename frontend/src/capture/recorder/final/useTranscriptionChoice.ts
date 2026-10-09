import { useCallback, useEffect, useState } from "react";
import {
  OnDeviceStt,
  type OnDeviceSttStatus,
} from "@/lib/voiceNotes/onDeviceStt";
import { nativeVoiceNotesAvailable } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { VoiceNoteTranscriptionProps } from "../transcriptionProps";
import {
  readIdentifySpeakers,
  readMode,
  scaleStops,
  writeIdentifySpeakers,
  writeMode,
  type ModeId,
  type ModeShell,
  type ModeStop,
} from "./transcriptionModes";

export const PRIVATE_UNAVAILABLE = "Not available right now";

export interface ScaleStop {
  stop: ModeStop;
  available: boolean;
  reason?: string;
}

export interface TranscriptionChoiceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
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
    if (!nativeVoiceNotesAvailable()) return;
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
  storage?: TranscriptionChoiceStorage;
}

/**
 * The privacy scale's state. Private is the existing private-cloud route: it
 * is offered when the build and account offer it, and the first time it is
 * chosen the one-time consent step runs, as in TranscriptionRouteControl.
 * Choosing any other mode turns a given consent off, as its Off does. Private
 * is displayed and stored only once consent is given.
 */
export function useTranscriptionChoice({
  shell,
  transcription,
  model,
  storage = globalThis.localStorage,
}: TranscriptionChoiceOptions) {
  const offered = transcription?.availability === "available";
  const consented = transcription?.consented ?? false;

  const stops: ScaleStop[] = scaleStops(shell, model).map(
    ({ availability, ...stop }) => {
      if (stop.id === "private" && !offered)
        return { stop, available: false, reason: PRIVATE_UNAVAILABLE };
      return availability.available
        ? { stop, available: true }
        : { stop, available: false, reason: availability.reason };
    },
  );
  const isAvailable = (id: ModeId) =>
    stops.some((s) => s.stop.id === id && s.available);

  const [stored, setStored] = useState<ModeId>(() =>
    readMode(shell, model, storage),
  );
  const [speakers, setSpeakers] = useState(() => readIdentifySpeakers(storage));
  const [asking, setAsking] = useState(false);

  // The scale shows the route the recorder will take. Private only counts once
  // consent is given, as TranscriptionRouteControl treats an unconsented route
  // as Off; until then the stored wish waits and the scale rests on the next
  // available stop.
  const wanted: ModeId = isAvailable(stored)
    ? stored
    : (stops.find((s) => s.available)?.stop.id ?? stored);
  const needsConsent = wanted === "private" && offered && !consented;
  const mode: ModeId = needsConsent
    ? (stops.find((s) => s.available && s.stop.id !== "private")?.stop.id ??
      "local")
    : wanted;

  const commit = useCallback(
    (id: ModeId) => {
      writeMode(id, shell, storage, model);
      setStored(id);
    },
    [shell, model, storage],
  );

  /** Returns why a stop cannot be chosen, or null when the choice was taken (or is waiting on consent). */
  const select = (id: ModeId): string | null => {
    const stop = stops.find((s) => s.stop.id === id);
    if (!stop) throw new Error(`Unknown transcription mode: ${id}`);
    if (!stop.available) return stop.reason ?? "Not available";
    if (id === "private") {
      if (!consented) setAsking(true);
      else if (mode !== "private") commit(id);
      return null;
    }
    if (id === mode && stored === id) return null;
    if (consented) transcription?.onTurnOff();
    commit(id);
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
    commit("private");
    setAsking(false);
  };

  const setIdentifySpeakers = (enabled: boolean) => {
    writeIdentifySpeakers(enabled, storage);
    setSpeakers(enabled);
  };

  return {
    mode,
    stops,
    select,
    step,
    identifySpeakers: speakers,
    setIdentifySpeakers,
    asking,
    needsConsent,
    dismissConsent: () => setAsking(false),
    confirmConsent,
    maxMinutes: Math.round((transcription?.maxSeconds ?? 0) / 60),
  };
}
