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
export interface ModeStop {
  id: ModeId;
  transcriber: TranscriberId | null;
  shortName: string;
  subLabel: string;
  captions: Record<ModeShell, string>;
  explanations: Record<ModeShell, string>;
  privacyDots: number;
  accuracyDots: number;
}
export const MODE_STOPS: readonly ModeStop[] = [
  {
    id: "skip",
    transcriber: null,
    shortName: COPY.skipName,
    subLabel: COPY.audioOnly,
    captions: COPY.skipCaption,
    explanations: {
      phone: COPY.skipExplanation,
      desktop: COPY.skipExplanation,
      web: COPY.skipExplanation,
    },
    privacyDots: 5,
    accuracyDots: 0,
  },
  {
    id: "local",
    transcriber: "on-device",
    shortName: COPY.localName,
    subLabel: FINAL_COPY.onThisPhone,
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
    privacyDots: 5,
    accuracyDots: 2,
  },
  {
    id: "private",
    transcriber: "private-cloud",
    shortName: COPY.privateName,
    subLabel: FINAL_COPY.sealedEnclave,
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
    privacyDots: 4,
    accuracyDots: 4,
  },
  {
    id: "powerful",
    transcriber: "assemblyai",
    shortName: COPY.powerfulName,
    subLabel: FINAL_COPY.assemblyAi,
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
    privacyDots: 2,
    accuracyDots: 5,
  },
];
export type Availability = { available: boolean; reason?: string };
export function modeAvailability(
  id: ModeId,
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): Availability {
  if (id === "skip" || id === "private") return { available: true };
  if (id === "powerful")
    return features.powerfulEnabled
      ? { available: true }
      : { available: false, reason: FINAL_COPY.comingNextUpdate };
  if (shell === "web") return { available: false, reason: FINAL_COPY.needsApp };
  if (shell === "desktop")
    return {
      available: whisperDownloaded,
      reason: FINAL_COPY.whisperUnavailable,
    };
  return {
    available: Boolean(
      model?.models.some(
        (m) => m.id.startsWith("parakeet") && m.state === "ready",
      ) ||
      (model?.engine === "apple-speech" && model.appleSpeech === "ready"),
    ),
    reason: FINAL_COPY.modelUnavailable,
  };
}
export function availableStops(
  shell: ModeShell,
  model?: OnDeviceSttStatus | null,
  whisperDownloaded = false,
  features: ModeFeatures = DEFAULT_FEATURES,
): ModeStop[] {
  return MODE_STOPS.filter(
    (stop) =>
      (stop.id !== "skip" || features.skipEnabled) &&
      modeAvailability(stop.id, shell, model, whisperDownloaded, features)
        .available,
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
  if (!available.length)
    throw new Error("No transcription modes are available");
  const at = available.findIndex((s) => s.id === current);
  return available[
    Math.max(
      0,
      Math.min(
        available.length - 1,
        (at < 0 ? (direction > 0 ? -1 : available.length) : at) + direction,
      ),
    )
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
  features: ModeFeatures = DEFAULT_FEATURES,
): ModeId {
  if (
    shell === "desktop" &&
    modeAvailability("local", shell, model, whisperDownloaded, features)
      .available
  )
    return "local";
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
  return stored &&
    MODE_STOPS.some(
      (stop) =>
        stop.id === stored &&
        modeAvailability(stop.id, shell, model, whisperDownloaded, features)
          .available &&
        (stop.id !== "skip" || features.skipEnabled),
    )
    ? (stored as ModeId)
    : defaultMode(shell, model, whisperDownloaded, features);
}
export function writeMode(
  id: ModeId,
  storage: Pick<ModeStorage, "setItem">,
  features: ModeFeatures = DEFAULT_FEATURES,
): void {
  if (
    !MODE_STOPS.some((stop) => stop.id === id) ||
    (id === "skip" && !features.skipEnabled) ||
    (id === "powerful" && !features.powerfulEnabled)
  ) {
    throw new Error(`Mode is not enabled: ${id}`);
  }
  storage.setItem(CHOICE_KEY, id);
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
  if (!MODE_STOPS.some((s) => s.id === mode))
    throw new Error(`Unknown transcription mode: ${mode}`);
  return mode === "powerful" && identifySpeakers && powerfulEnabled
    ? COPY.speakersName
    : MODE_STOPS.find((s) => s.id === mode)!.shortName;
}
export function modeSubLabel(mode: ModeId, shell: ModeShell): string {
  if (mode === "local")
    return shell === "desktop"
      ? FINAL_COPY.onThisMac
      : shell === "phone"
        ? FINAL_COPY.onThisPhone
        : FINAL_COPY.needsApp;
  return (
    MODE_STOPS.find((s) => s.id === mode)?.subLabel ??
    (() => {
      throw new Error(`Unknown transcription mode: ${mode}`);
    })()
  );
}
export function identifySpeakersControl(
  mode: ModeId,
  enabled: boolean,
  powerfulEnabled = POWERFUL_ENABLED,
) {
  return {
    label: FINAL_COPY.identifySpeakers,
    subLabel: FINAL_COPY.powerfulOnly,
    checked: speakersEnabled(mode, powerfulEnabled) && enabled,
    disabled: !speakersEnabled(mode, powerfulEnabled),
  };
}
