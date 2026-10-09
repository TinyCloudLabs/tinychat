import { selectInput, type AudioInput, type AudioInputsSnapshot } from "@/lib/voiceNotes/nativeVoiceNotes";
import type { AudioInputsSource } from "../useAudioInputs";

export interface BrowserAudioInputsDeps {
  mediaDevices(): Pick<MediaDevices, "enumerateDevices" | "addEventListener" | "removeEventListener">;
  /** The installed engine's selectInput. */
  selectInput(id: string | null): Promise<void>;
}

function kindOf(label: string): AudioInput["kind"] {
  if (/built-?in|internal|macbook/i.test(label)) return "built_in";
  if (/bluetooth|airpods|buds/i.test(label)) return "bluetooth";
  if (/usb/i.test(label)) return "usb";
  return "other";
}

/** A browser hides device labels until the page has had microphone permission; the list is renumbered then. */
export function toAudioInputs(devices: readonly MediaDeviceInfo[]): AudioInput[] {
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId !== "communications")
    .map((device, index) => ({
      id: device.deviceId,
      name: device.label || `Microphone ${index + 1}`,
      kind: kindOf(device.label),
    }));
}

/** The microphones a browser lists through enumerateDevices(), following devicechange; a choice goes to the engine. */
export function createBrowserAudioInputs(deps: BrowserAudioInputsDeps): AudioInputsSource {
  let selectedId: string | null = null;
  const snapshot = async (): Promise<AudioInputsSnapshot> => {
    const inputs = toAudioInputs(await deps.mediaDevices().enumerateDevices());
    if (selectedId !== null && !inputs.some((input) => input.id === selectedId)) selectedId = null;
    return { inputs, selectedId, activeId: null };
  };
  return {
    list: snapshot,
    async select(id) {
      await deps.selectInput(id);
      selectedId = id;
    },
    subscribe(listener, onError) {
      const devices = deps.mediaDevices();
      const onChange = () => {
        snapshot().then(listener, (caught: unknown) => onError?.(caught));
      };
      devices.addEventListener("devicechange", onChange);
      return () => devices.removeEventListener("devicechange", onChange);
    },
  };
}

export const browserAudioInputs: AudioInputsSource = createBrowserAudioInputs({
  mediaDevices: () => {
    if (!navigator.mediaDevices) throw new Error("This browser cannot list microphones");
    return navigator.mediaDevices;
  },
  selectInput,
});
