import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useAudioInputs } from "../useAudioInputs";
import { createBrowserAudioInputs } from "./browserAudioInputs";
import { installReactTestEnv, mount } from "./hookTestUtil";

const device = (deviceId: string, label: string) =>
  ({ deviceId, label, kind: "audioinput", groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;

async function until(condition: () => boolean, what: string) {
  for (let i = 0; i < 500 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error(`Timed out waiting for ${what}`);
}

describe("useAudioInputs on a browser source", () => {
  let restoreEnv: () => void;
  beforeEach(() => {
    restoreEnv = installReactTestEnv();
  });
  afterEach(() => restoreEnv());

  test("choosing a microphone updates the displayed choice at once, without a device event", async () => {
    const events = new EventTarget();
    const source = createBrowserAudioInputs({
      mediaDevices: () => ({
        enumerateDevices: async () => [device("a", "Mic A"), device("b", "Mic B")],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      }),
      selectInput: async () => {},
    });
    let latest: ReturnType<typeof useAudioInputs> | null = null;
    function Probe() {
      latest = useAudioInputs(source);
      return null;
    }
    const view = mount();
    await view.render(<Probe />);
    await act(async () => {
      await until(() => latest?.inputs.length === 2, "the microphones to load");
    });
    expect(latest!.current?.id).toBe("a");
    expect(latest!.selectedId).toBeNull();

    await act(async () => {
      await latest!.select("b");
    });
    await until(() => latest?.selectedId === "b", "the chosen microphone to show");
    expect(latest!.current).toEqual({ id: "b", name: "Mic B", kind: "other" });
    await view.unmount();
  });
});
