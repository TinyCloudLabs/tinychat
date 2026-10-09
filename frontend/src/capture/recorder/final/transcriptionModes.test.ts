import { describe, expect, test } from "bun:test";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import {
  availableStops,
  defaultMode,
  identifySpeakersControl,
  modeAvailability,
  modeShortLabel,
  moveMode,
  readIdentifySpeakers,
  readMode,
  writeIdentifySpeakers,
  writeMode,
  type ModeFeatures,
  type ModeShell,
} from "./transcriptionModes";

function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function model(
  state: OnDeviceSttStatus["models"][number]["state"],
): OnDeviceSttStatus {
  return {
    models: [
      {
        id: "parakeet-tdt-0.6b-v3-int8",
        state,
        bytes: 0,
        totalBytes: 1,
        error: null,
      },
    ],
    pack: "full",
    autoDownload: false,
    download: { policy: "wifi", state: "idle" },
    engine: "parakeet",
    appleSpeech: "unsupported",
    queue: [],
  };
}

const shells: ModeShell[] = ["phone", "desktop", "web"];
const modelStates: OnDeviceSttStatus["models"][number]["state"][] = [
  "absent",
  "queued",
  "downloading",
  "verifying",
  "ready",
  "failed",
];

describe("transcription modes availability", () => {
  test.each(
    shells.flatMap((shell) =>
      modelStates.map((state) => [shell, state] as const),
    ),
  )("%s Local availability with model state %s", (shell, state) => {
    const available = modeAvailability(
      "local",
      shell,
      model(state),
      false,
    ).available;
    expect(available).toBe(shell === "phone" && state === "ready");
  });

  test.each(modelStates)(
    "web never offers Local regardless of model state %s",
    (state) => {
      expect(modeAvailability("local", "web", model(state))).toEqual({
        available: false,
        reason: "needs the app",
      });
    },
  );

  test("desktop Local depends on the Whisper download state", () => {
    expect(modeAvailability("local", "desktop", null, false).available).toBe(
      false,
    );
    expect(modeAvailability("local", "desktop", null, true).available).toBe(
      true,
    );
    expect(
      availableStops("desktop", null, false).map((stop) => stop.id),
    ).toEqual(["private"]);
    expect(
      availableStops("desktop", null, true).map((stop) => stop.id),
    ).toEqual(["local", "private"]);
  });

  test("Powerful remains disabled with its launch copy on every shell", () => {
    for (const shell of shells) {
      expect(modeAvailability("powerful", shell)).toEqual({
        available: false,
        reason: "Coming with the next update",
      });
    }
  });

  test("arrow navigation skips unavailable Local and Powerful stops", () => {
    const disabledFeatures: ModeFeatures = {
      skipEnabled: false,
      powerfulEnabled: false,
    };
    const enabledEdges: ModeFeatures = {
      skipEnabled: true,
      powerfulEnabled: true,
    };
    expect(
      moveMode("local", 1, "phone", model("ready"), false, disabledFeatures),
    ).toBe("private");
    expect(moveMode("private", -1, "web", null, false, enabledEdges)).toBe(
      "skip",
    );
    expect(moveMode("skip", 1, "web", null, false, enabledEdges)).toBe(
      "private",
    );
    expect(moveMode("private", 1, "web", null, false, enabledEdges)).toBe(
      "powerful",
    );
  });
});

describe("transcription mode defaults and storage", () => {
  test("phone and web default to Private; desktop defaults depend on Whisper", () => {
    expect(defaultMode("phone", model("ready"))).toBe("private");
    expect(defaultMode("web")).toBe("private");
    expect(defaultMode("desktop", null, true)).toBe("local");
    expect(defaultMode("desktop", null, false)).toBe("private");
  });

  test("sticky selections round-trip and unavailable stored modes fall back to the shell default", () => {
    const selected = storage();
    writeMode("local", selected);
    expect(readMode("desktop", null, selected, true)).toBe("local");
    expect(readMode("desktop", null, selected, false)).toBe("private");

    const privateChoice = storage();
    writeMode("private", privateChoice);
    expect(readMode("phone", model("absent"), privateChoice)).toBe("private");
  });
});

describe("Identify speakers", () => {
  test("is sticky, off by default, enabled only for selected Powerful, and changes its short label", () => {
    const selected = storage();
    expect(readIdentifySpeakers(selected)).toBe(false);
    writeIdentifySpeakers(true, selected);
    expect(readIdentifySpeakers(selected)).toBe(true);

    expect(identifySpeakersControl("private", true, true)).toMatchObject({
      checked: false,
      disabled: true,
    });
    expect(identifySpeakersControl("powerful", false, true)).toMatchObject({
      checked: false,
      disabled: false,
    });
    expect(identifySpeakersControl("powerful", true, true)).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(modeShortLabel("powerful", true, true)).toBe(
      "AssemblyAI · speakers",
    );
    expect(modeShortLabel("powerful", false, true)).toBe("Powerful");
  });
});
