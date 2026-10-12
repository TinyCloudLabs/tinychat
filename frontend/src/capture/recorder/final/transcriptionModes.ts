import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { isAppleSpeech, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { FINAL_COPY } from "./finalCopy";

const COPY = FINAL_COPY.modes;

export type ModeShell = "phone" | "desktop" | "web";
export type ModeId = "skip" | "local" | "private" | "powerful";
export type DotCount = 0 | 1 | 2 | 3 | 4;
export interface ModeExplanationContext {
  modelName: string;
}
export type ModeExplanation = (context: ModeExplanationContext) => string;
export type Availability =
  | { available: true }
  | { available: false; reason: string };

function explain(text: string): ModeExplanation {
  return () => text;
}

export interface ModeStop {
  id: ModeId;
  transcriber: TranscriberId | null;
  shortName: string;
  subLabel: Record<ModeShell, string>;
  captions: Record<ModeShell, string>;
  explanations: Record<ModeShell, ModeExplanation>;
  privacyDots: DotCount;
  accuracyDots: DotCount;
}

export const MODE_STOPS: readonly ModeStop[] = [
  {
    id: "skip",
    transcriber: null,
    shortName: COPY.skipName,
    subLabel: {
      phone: COPY.noTranscript,
      desktop: COPY.noTranscript,
      web: COPY.noTranscript,
    },
    captions: COPY.skipCaption,
    explanations: {
      phone: explain(COPY.skipExplanation),
      desktop: explain(COPY.skipExplanation),
      web: explain(COPY.skipExplanation),
    },
    privacyDots: 4,
    accuracyDots: 0,
  },
  {
    id: "local",
    transcriber: "on-device",
    shortName: COPY.localName,
    subLabel: {
      phone: FINAL_COPY.onThisPhone,
      desktop: FINAL_COPY.onThisMac,
      web: FINAL_COPY.needsApp,
    },
    captions: {
      phone: COPY.localPhoneCaption,
      desktop: COPY.localDesktopCaption,
      web: FINAL_COPY.needsApp,
    },
    explanations: {
      phone: explain(COPY.localPhoneExplanation),
      desktop: ({ modelName }) => COPY.localDesktopExplanation(modelName),
      web: explain(COPY.localWebExplanation),
    },
    privacyDots: 4,
    accuracyDots: 2,
  },
  {
    id: "private",
    transcriber: "private-cloud",
    shortName: COPY.privateName,
    subLabel: {
      phone: FINAL_COPY.sealedEnclave,
      desktop: FINAL_COPY.sealedEnclave,
      web: FINAL_COPY.sealedEnclave,
    },
    captions: {
      phone: COPY.privateCaption,
      desktop: COPY.privateCaption,
      web: COPY.privateCaption,
    },
    explanations: {
      phone: explain(COPY.privateExplanation),
      desktop: explain(COPY.privateExplanation),
      web: explain(COPY.privateExplanation),
    },
    privacyDots: 3,
    accuracyDots: 3,
  },
  {
    id: "powerful",
    transcriber: "assemblyai",
    shortName: COPY.powerfulName,
    subLabel: { phone: "via Exo's server", desktop: "via Exo's server", web: "via Exo's server" },
    captions: { phone: COPY.powerfulCaption, desktop: COPY.powerfulCaption, web: COPY.powerfulCaption },
    explanations: { phone: explain(COPY.powerfulExplanation), desktop: explain(COPY.powerfulExplanation), web: explain(COPY.powerfulExplanation) },
    privacyDots: 1,
    accuracyDots: 4,
  },
];

/** Every picker mode has one stop. Reject unknown journal values with a typed error. */
export function modeStop(id: ModeId): ModeStop {
  switch (id) {
    case "skip": return MODE_STOPS[0]!;
    case "local": return MODE_STOPS[1]!;
    case "private": return MODE_STOPS[2]!;
    case "powerful": return MODE_STOPS[3]!;
    default: {
      const exhaustive: never = id;
      throw Object.assign(new Error(`Unknown transcription mode: ${String(exhaustive)}`), { code: "unknown_transcription_mode" as const });
    }
  }
}

export function modeAvailability(
  id: ModeId,
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
): Availability {
  if (id === "skip") return { available: true };
  if (id === "private") return { available: true };
  if (id === "powerful") return { available: true };
  if (shell === "web") {
    return { available: false, reason: FINAL_COPY.needsApp };
  }
  if (shell === "desktop") {
    return whisperDownloaded
      ? { available: true }
      : { available: false, reason: FINAL_COPY.whisperUnavailable };
  }

  if (model && isAppleSpeech(model)) {
    if (model.appleSpeech === "unsupported") return { available: false, reason: FINAL_COPY.speechUnsupported };
    if (model.appleSpeech === "locale_unsupported") return { available: false, reason: FINAL_COPY.speechLocaleUnsupported };
  }
  // Local is always choosable once the phone's model status is known: a missing model downloads on its own and notes wait for it.
  return model
    ? { available: true }
    : { available: false, reason: FINAL_COPY.modelUnavailable };
}

export function scaleStops(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
): Array<ModeStop & { availability: Availability }> {
  return MODE_STOPS.map((stop) => ({
    ...stop,
    availability: modeAvailability(
      stop.id,
      shell,
      model,
      whisperDownloaded,
    ),
  }));
}

export function availableStops(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
): ModeStop[] {
  return scaleStops(shell, model, whisperDownloaded).filter(
    (stop) => stop.availability.available,
  );
}

export function moveMode(
  current: ModeId,
  direction: -1 | 1,
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
): ModeId {
  const available = availableStops(shell, model, whisperDownloaded);
  if (available.length === 0) {
    throw new Error("No transcription modes are available");
  }
  const at = available.findIndex((stop) => stop.id === current);
  const from = at < 0 ? (direction > 0 ? -1 : available.length) : at;
  return available[
    Math.max(0, Math.min(available.length - 1, from + direction))
  ]!.id;
}

export function speakersEnabled(mode: ModeId, privateDiarization = false): boolean {
  return mode === "powerful" || (mode === "private" && privateDiarization);
}

export function modeShortLabel(
  mode: ModeId,
  _identifySpeakers: boolean,
): string {
  switch (mode) {
    case "skip":
      return COPY.skipName;
    case "local":
      return COPY.localName;
    case "private":
      return COPY.privateName;
    case "powerful":
      return COPY.powerfulName;
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown transcription mode: ${String(exhaustive)}`);
    }
  }
}

export function identifySpeakersControl(
  mode: ModeId,
  enabled: boolean,
  privateDiarization = false,
) {
  const supported = speakersEnabled(mode, privateDiarization);
  return {
    label: FINAL_COPY.identifySpeakers,
    subLabel: supported ? FINAL_COPY.speakerTurns : FINAL_COPY.notSupported,
    checked: enabled && supported,
    disabled: !supported,
  };
}
