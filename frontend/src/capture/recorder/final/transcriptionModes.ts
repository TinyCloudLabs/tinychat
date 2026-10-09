import type { TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { FINAL_COPY } from "./finalCopy";

export const SKIP_ENABLED = false;
export const POWERFUL_ENABLED = false;

export interface ModeFeatures {
  skipEnabled: boolean;
  powerfulEnabled: boolean;
}

const DEFAULT_FEATURES: ModeFeatures = {
  skipEnabled: SKIP_ENABLED,
  powerfulEnabled: POWERFUL_ENABLED,
};
const COPY = FINAL_COPY.modes;

export type ModeShell = "phone" | "desktop" | "web";
export type ModeId = "skip" | "local" | "private" | "powerful";
export type DotCount = 0 | 1 | 2 | 3 | 4;
export type Availability =
  | { available: true }
  | { available: false; reason: string };

export interface ModeStop {
  id: ModeId;
  transcriber: TranscriberId | null;
  shortName: string;
  subLabel: Record<ModeShell, string>;
  captions: Record<ModeShell, string>;
  explanations: Record<ModeShell, string | ((modelName: string) => string)>;
  privacyDots: DotCount;
  accuracyDots: DotCount;
}

export const MODE_STOPS: readonly ModeStop[] = [
  {
    id: "skip",
    transcriber: null,
    shortName: COPY.skipName,
    subLabel: {
      phone: COPY.audioOnly,
      desktop: COPY.audioOnly,
      web: COPY.audioOnly,
    },
    captions: COPY.skipCaption,
    explanations: {
      phone: COPY.skipExplanation,
      desktop: COPY.skipExplanation,
      web: COPY.skipExplanation,
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
      phone: COPY.localPhoneExplanation,
      desktop: COPY.localDesktopExplanation,
      web: COPY.localWebExplanation,
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
      phone: COPY.privateExplanation,
      desktop: COPY.privateExplanation,
      web: COPY.privateExplanation,
    },
    privacyDots: 3,
    accuracyDots: 3,
  },
  {
    id: "powerful",
    transcriber: "assemblyai",
    shortName: COPY.powerfulName,
    subLabel: {
      phone: FINAL_COPY.assemblyAi,
      desktop: FINAL_COPY.assemblyAi,
      web: FINAL_COPY.assemblyAi,
    },
    captions: {
      phone: COPY.powerfulCaption,
      desktop: COPY.powerfulCaption,
      web: COPY.powerfulCaption,
    },
    explanations: {
      phone: COPY.powerfulExplanation,
      desktop: COPY.powerfulExplanation,
      web: COPY.powerfulExplanation,
    },
    privacyDots: 1,
    accuracyDots: 4,
  },
];

export function modeAvailability(
  id: ModeId,
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): Availability {
  if (id === "skip") {
    return features.skipEnabled
      ? { available: true }
      : { available: false, reason: FINAL_COPY.skipDisabled };
  }
  if (id === "private") return { available: true };
  if (id === "powerful") {
    return features.powerfulEnabled
      ? { available: true }
      : { available: false, reason: FINAL_COPY.comingNextUpdate };
  }
  if (shell === "web") {
    return { available: false, reason: FINAL_COPY.needsApp };
  }
  if (shell === "desktop") {
    return whisperDownloaded
      ? { available: true }
      : { available: false, reason: FINAL_COPY.whisperUnavailable };
  }

  // TODO(TC-836): confirm whether readiness must also require engine and Silero VAD state; native status currently reports a stub.
  const ready = Boolean(
    model?.models.some(
      (entry) => entry.id.startsWith("parakeet") && entry.state === "ready",
    ) ||
    (model?.engine === "apple-speech" && model.appleSpeech === "ready"),
  );
  return ready
    ? { available: true }
    : { available: false, reason: FINAL_COPY.modelUnavailable };
}

export function scaleStops(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): Array<ModeStop & { availability: Availability }> {
  return MODE_STOPS.filter(
    (stop) => stop.id !== "skip" || features.skipEnabled,
  ).map((stop) => ({
    ...stop,
    availability: modeAvailability(
      stop.id,
      shell,
      model,
      whisperDownloaded,
      features,
    ),
  }));
}

export function availableStops(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): ModeStop[] {
  return scaleStops(shell, model, whisperDownloaded, features).filter(
    (stop) => stop.availability.available,
  );
}

export function moveMode(
  current: ModeId,
  direction: -1 | 1,
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): ModeId {
  const available = availableStops(shell, model, whisperDownloaded, features);
  if (available.length === 0) {
    throw new Error("No transcription modes are available");
  }
  const at = available.findIndex((stop) => stop.id === current);
  const from = at < 0 ? (direction > 0 ? -1 : available.length) : at;
  return available[
    Math.max(0, Math.min(available.length - 1, from + direction))
  ]!.id;
}

export interface ModeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const CHOICE_KEY = "exo.recorder.transcription-mode";
const SPEAKERS_KEY = "exo.recorder.identify-speakers";

export function defaultMode(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
): ModeId {
  if (
    shell === "desktop" &&
    modeAvailability("local", shell, model, whisperDownloaded).available
  ) {
    return "local";
  }
  return "private";
}

export function readMode(
  shell: ModeShell,
  model: OnDeviceSttStatus | null,
  storage: Pick<ModeStorage, "getItem">,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): ModeId {
  const stored = storage.getItem(CHOICE_KEY);
  if (stored && isModeId(stored)) {
    const availability = modeAvailability(
      stored,
      shell,
      model,
      whisperDownloaded,
      features,
    );
    if (availability.available) return stored;
  }
  return defaultMode(shell, model, whisperDownloaded);
}

export function writeMode(
  id: ModeId,
  shell: ModeShell,
  storage: Pick<ModeStorage, "setItem">,
  model: OnDeviceSttStatus | null = null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): void {
  const availability = modeAvailability(
    id,
    shell,
    model,
    whisperDownloaded,
    features,
  );
  if (!availability.available) {
    throw new Error(`Mode is not available: ${availability.reason}`);
  }
  storage.setItem(CHOICE_KEY, id);
}

function isModeId(value: string): value is ModeId {
  switch (value) {
    case "skip":
    case "local":
    case "private":
    case "powerful":
      return true;
    default:
      return false;
  }
}

export function readIdentifySpeakers(
  storage: Pick<ModeStorage, "getItem">,
): boolean {
  return storage.getItem(SPEAKERS_KEY) === "true";
}

export function writeIdentifySpeakers(
  enabled: boolean,
  storage: Pick<ModeStorage, "setItem">,
): void {
  storage.setItem(SPEAKERS_KEY, String(enabled));
}

export function speakersEnabled(
  mode: ModeId,
  powerfulEnabled = POWERFUL_ENABLED,
): boolean {
  return mode === "powerful" && powerfulEnabled;
}

export function modeShortLabel(
  mode: ModeId,
  identifySpeakers: boolean,
  powerfulEnabled = POWERFUL_ENABLED,
): string {
  if (mode === "powerful" && identifySpeakers && powerfulEnabled) {
    return COPY.speakersName;
  }
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
  powerfulEnabled = POWERFUL_ENABLED,
) {
  return {
    label: FINAL_COPY.identifySpeakers,
    subLabel: FINAL_COPY.powerfulOnly,
    checked: enabled,
    disabled: !speakersEnabled(mode, powerfulEnabled),
  };
}
