import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "@/lib/voiceNotes/fakeVoiceNotes";
import { __setVoiceNotesForTests } from "@/lib/voiceNotes/nativeVoiceNotes";
import { isOnDeviceReady, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { FINAL_COPY } from "./finalCopy";
import {
  availableStops,
  identifySpeakersControl,
  MODE_STOPS,
  modeAvailability,
  modeStop,
  moveMode,
  scaleStops,
  type ModeShell,
} from "./transcriptionModes";

beforeEach(() => __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: false }));
afterEach(() => __setVoiceNotesForTests(createFakeVoiceNotes().plugin, { available: null }));

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
      {
        id: "silero-vad",
        state: "ready",
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

  test("scaleStops includes Powerful on the web", () => {
    const stops = scaleStops("web");
    expect(stops.map(({ id }) => id)).toEqual([
      "skip",
      "local",
      "private",
      "powerful",
    ]);
    expect(stops.find(({ id }) => id === "local")?.availability).toEqual({
      available: false,
      reason: "needs the app",
    });
  });

  test("Audio only is available", () => {
    expect(modeAvailability("skip", "phone")).toEqual({ available: true });
  });

  test("Local shows shell-specific copy and names the selected Mac model", () => {
    const local = modeStop("local");
    const context = { modelName: "Example Model" };
    const captions = shells.map((shell) => local.captions[shell]);
    const explanations = shells.map((shell) => local.explanations[shell](context));

    expect(new Set(captions).size).toBe(shells.length);
    expect(new Set(explanations).size).toBe(shells.length);
    expect(local.explanations.desktop(context)).toContain(context.modelName);
    expect(local.captions.web).toBe(FINAL_COPY.needsApp);
    expect(local.explanations.web(context)).toBe(FINAL_COPY.modes.localWebExplanation);
  });

  test("unknown mode ids fail with a typed error", () => {
    expect(() => modeStop("unlisted" as never)).toThrow("Unknown transcription mode: unlisted");
    try { modeStop("unlisted" as never); } catch (error) {
      expect(error).toMatchObject({ code: "unknown_transcription_mode" });
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
    expect(available).toBe(shell === "phone");
  });

  test("phone Local is not offered only while the phone's model status is unknown", () => {
    expect(modeAvailability("local", "phone", null).available).toBe(false);
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
    ).toEqual(["skip", "private", "powerful"]);
    expect(
      availableStops("desktop", null, true).map((stop) => stop.id),
    ).toEqual(["skip", "local", "private", "powerful"]);
    expect(scaleStops("desktop", null, false)[1]?.availability).toEqual({
      available: false,
      reason: "Get Whisper for this Mac",
    });
    expect(scaleStops("desktop", null, true)[1]?.availability).toEqual({
      available: true,
    });
  });

  test("Powerful is in the picker on every shell", () => {
    for (const shell of shells) {
      expect(scaleStops(shell).some((stop) => stop.id === "powerful")).toBe(true);
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

  test("iOS speech that cannot run here makes Local unavailable with a calm reason", () => {
    const apple = (appleSpeech: "unsupported" | "locale_unsupported") => ({
      ...model("absent"),
      engine: "apple-speech" as const,
      appleSpeech,
    });
    expect(modeAvailability("local", "phone", apple("unsupported"))).toEqual({
      available: false,
      reason: "On-device transcription isn't available on this iPhone",
    });
    expect(modeAvailability("local", "phone", apple("locale_unsupported"))).toEqual({
      available: false,
      reason: "On-device transcription doesn't support this language yet",
    });
  });

  describe("on-device readiness is native's own predicate", () => {
    const local = (status: OnDeviceSttStatus) =>
      isOnDeviceReady(status);
    const withModels = (
      patch: Partial<OnDeviceSttStatus>,
      ...models: OnDeviceSttStatus["models"]
    ): OnDeviceSttStatus => ({
      ...model("ready"),
      ...patch,
      models,
    });
    const entry = (
      id: OnDeviceSttStatus["models"][number]["id"],
      state: OnDeviceSttStatus["models"][number]["state"],
    ) => ({ id, state, bytes: 0, totalBytes: 1, error: null });

    test("parakeet needs this pack's model and the VAD, both ready", () => {
      expect(local(model("ready"))).toBe(true);
      expect(
        local(withModels({}, entry("parakeet-tdt-0.6b-v3-int8", "ready"))),
      ).toBe(false);
      expect(local(withModels({}, entry("silero-vad", "ready")))).toBe(false);
      expect(
        local(
          withModels(
            {},
            entry("parakeet-tdt-0.6b-v3-int8", "downloading"),
            entry("silero-vad", "ready"),
          ),
        ),
      ).toBe(false);
    });

    test("the model must be the one this browser's pack uses", () => {
      expect(
        local(
          withModels(
            { pack: "small" },
            entry("parakeet-tdt-0.6b-v3-int8", "ready"),
            entry("silero-vad", "ready"),
          ),
        ),
      ).toBe(false);
      expect(
        local(
          withModels(
            { pack: "small" },
            entry("parakeet-tdt-110m-en-int8", "ready"),
            entry("silero-vad", "ready"),
          ),
        ),
      ).toBe(true);
    });

    test("the engine must be parakeet (or a ready apple-speech)", () => {
      expect(local({ ...model("ready"), engine: "none" })).toBe(false);
      expect(
        local({
          ...model("absent"),
          engine: "apple-speech",
          appleSpeech: "ready",
        }),
      ).toBe(true);
      expect(
        local({
          ...model("ready"),
          engine: "apple-speech",
          appleSpeech: "unsupported",
        }),
      ).toBe(false);
    });
  });

  test("arrow navigation skips unavailable Local", () => {
    expect(
      moveMode("local", 1, "phone", model("ready"), false),
    ).toBe("private");
    expect(moveMode("private", -1, "web", null, false)).toBe(
      "skip",
    );
    expect(moveMode("skip", 1, "web", null, false)).toBe(
      "private",
    );
    expect(moveMode("private", 1, "web", null, false)).toBe("powerful");
  });
});

describe("Identify speakers", () => {
  test("is enabled for Private, and says Not supported for Local and Audio only", () => {
    expect(identifySpeakersControl("powerful", true)).toMatchObject({ checked: true, disabled: false });
    expect(identifySpeakersControl("private", true, true)).toMatchObject({
      checked: true,
      disabled: false,
    });
    expect(identifySpeakersControl("private", true, false)).toMatchObject({
      checked: false, disabled: true, subLabel: "Not supported",
    });
    for (const mode of ["local", "skip"] as const) {
      expect(identifySpeakersControl(mode, true)).toMatchObject({
        checked: false, disabled: true, subLabel: "Not supported",
      });
    }
  });
});
