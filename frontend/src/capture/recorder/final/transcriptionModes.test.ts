import { describe, expect, test } from "bun:test";
import type { OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import {
  availableStops,
  defaultMode,
  identifySpeakersControl,
  MODE_STOPS,
  modeAvailability,
  modeShortLabel,
  moveMode,
  readIdentifySpeakers,
  readMode,
  scaleStops,
  SKIP_ENABLED,
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
  test("prototype dot counts stay within the four-dot scale", () => {
    expect(
      MODE_STOPS.map(({ id, privacyDots, accuracyDots }) => [
        id,
        privacyDots,
        accuracyDots,
      ]),
    ).toEqual([
      ["skip", 4, 0],
      ["local", 4, 2],
      ["private", 3, 3],
      ["powerful", 1, 4],
    ]);
    for (const stop of MODE_STOPS) {
      expect(stop.privacyDots).toBeGreaterThanOrEqual(0);
      expect(stop.privacyDots).toBeLessThanOrEqual(4);
      expect(stop.accuracyDots).toBeGreaterThanOrEqual(0);
      expect(stop.accuracyDots).toBeLessThanOrEqual(4);
    }
  });

  test("scaleStops includes disabled rows but removes Skip when the flag is off", () => {
    const stops = scaleStops("web");
    expect(stops.map(({ id }) => id)).toEqual(["local", "private", "powerful"]);
    expect(stops.find(({ id }) => id === "powerful")?.availability).toEqual({
      available: false,
      reason: "Coming with the next update",
    });
    expect(stops.find(({ id }) => id === "local")?.availability).toEqual({
      available: false,
      reason: "needs the app",
    });
    expect(
      scaleStops("web", null, false, {
        skipEnabled: true,
        powerfulEnabled: false,
      }).map(({ id }) => id),
    ).toEqual(["skip", "local", "private", "powerful"]);
  });

  test("Skip availability follows the feature flag", () => {
    expect(modeAvailability("skip", "phone")).toEqual(
      SKIP_ENABLED
        ? { available: true }
        : { available: false, reason: "Skip is not available" },
    );
    expect(
      modeAvailability("skip", "phone", null, false, {
        skipEnabled: true,
        powerfulEnabled: false,
      }),
    ).toEqual({ available: true });
  });

  test("captions and explanations match the shell-specific mode copy", () => {
    const expected = {
      skip: {
        phone: [
          "Just the recording, kept on this phone.",
          "audio only",
          "Only the audio is saved. Transcribe it later if you like.",
        ],
        desktop: [
          "Just the recording, saved to your space.",
          "audio only",
          "Only the audio is saved. Transcribe it later if you like.",
        ],
        web: [
          "Just the recording, saved to your space.",
          "audio only",
          "Only the audio is saved. Transcribe it later if you like.",
        ],
      },
      local: {
        phone: [
          "Nothing leaves it; a little slower.",
          "on this phone",
          "An on-device model transcribes it. Nothing leaves your phone; slower and less accurate.",
        ],
        desktop: [
          "Whisper on this Mac, after you stop.",
          "on this Mac",
          "Whisper Large transcribes on this Mac after you stop, and nothing leaves the machine. Change the model in ⚙︎ Settings.",
        ],
        web: [
          "needs the app",
          "needs the app",
          "Runs on your phone or Mac in the Exo app. Not available in the browser.",
        ],
      },
      private: {
        phone: [
          "Fast, accurate, and sealed from Exo.",
          "sealed enclave",
          "Transcribed in a sealed hardware enclave. Not even Exo can read it. Fast and accurate.",
        ],
        desktop: [
          "Fast, accurate, and sealed from Exo.",
          "sealed enclave",
          "Transcribed in a sealed hardware enclave. Not even Exo can read it. Fast and accurate.",
        ],
        web: [
          "Fast, accurate, and sealed from Exo.",
          "sealed enclave",
          "Transcribed in a sealed hardware enclave. Not even Exo can read it. Fast and accurate.",
        ],
      },
      powerful: {
        phone: [
          "Most accurate. Audio deleted after processing.",
          "AssemblyAI",
          "Uploaded to AssemblyAI, a third-party service: the most accurate, with speaker labels. Audio is deleted after processing.",
        ],
        desktop: [
          "Most accurate. Audio deleted after processing.",
          "AssemblyAI",
          "Uploaded to AssemblyAI, a third-party service: the most accurate, with speaker labels. Audio is deleted after processing.",
        ],
        web: [
          "Most accurate. Audio deleted after processing.",
          "AssemblyAI",
          "Uploaded to AssemblyAI, a third-party service: the most accurate, with speaker labels. Audio is deleted after processing.",
        ],
      },
    } as const;

    for (const stop of MODE_STOPS) {
      for (const shell of shells) {
        const [caption, subLabel, explanation] = expected[stop.id][shell];
        expect(stop.captions[shell]).toBe(caption);
        expect(stop.subLabel[shell]).toBe(subLabel);
        const actualExplanation = stop.explanations[shell];
        expect(
          typeof actualExplanation === "function"
            ? actualExplanation("Large")
            : actualExplanation,
        ).toBe(explanation);
      }
    }
  });

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
    expect(scaleStops("desktop", null, false)[0]?.availability).toEqual({
      available: false,
      reason: "Get Whisper for this Mac",
    });
    expect(scaleStops("desktop", null, true)[0]?.availability).toEqual({
      available: true,
    });
  });

  test("Powerful remains disabled with its launch copy on every shell", () => {
    for (const shell of shells) {
      expect(modeAvailability("powerful", shell)).toEqual({
        available: false,
        reason: "Coming with the next update",
      });
    }
  });

  test("Apple Speech readiness makes Local available on phone", () => {
    const status = {
      ...model("absent"),
      engine: "apple-speech" as const,
      appleSpeech: "ready" as const,
    };
    expect(modeAvailability("local", "phone", status)).toEqual({
      available: true,
    });
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
    for (const shell of shells) {
      expect(defaultMode(shell, model("ready"), true)).not.toBe("powerful");
      expect(defaultMode(shell, model("ready"), true)).toBe(
        shell === "desktop" ? "local" : "private",
      );
    }
  });

  test("sticky selections round-trip and unavailable stored modes fall back to the shell default", () => {
    const selected = storage();
    writeMode("local", "desktop", selected, null, true);
    expect(readMode("desktop", null, selected, true)).toBe("local");
    expect(readMode("desktop", null, selected, false)).toBe("private");

    const privateChoice = storage();
    writeMode("private", "phone", privateChoice, model("absent"));
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
      checked: true,
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
