// Powerful's provider is named in exactly two places, both from POWERFUL_PROVIDER_NAME: the consent small print and About.
// Every main surface says "an outside transcription service", so a provider switch is one edit.
import { describe, expect, test } from "bun:test";

import { routeText } from "@/chat/AudioUploadPanel";
import { uploadRoute } from "@/capture/sheetRoute";
import {
  FINAL_COPY,
  POWERFUL_CONSENT_BODY,
  POWERFUL_CONSENT_SMALL_PRINT,
  POWERFUL_CONSENT_UPLOAD_BODY,
  POWERFUL_NOT_PRIVATE_LINE,
  POWERFUL_PROVIDER_NAME,
} from "./finalCopy";

describe("Powerful copy is provider-agnostic outside the small print", () => {
  test("main-surface strings never name the provider", () => {
    const mainSurfaces = [
      POWERFUL_NOT_PRIVATE_LINE,
      POWERFUL_CONSENT_BODY,
      POWERFUL_CONSENT_UPLOAD_BODY,
      FINAL_COPY.modes.powerfulExplanation,
      routeText("assemblyai", "hosted"),
      ...uploadRoute("assemblyai", "hosted", "web").map((node) => node.label),
    ];
    for (const text of mainSurfaces) expect(text).not.toContain(POWERFUL_PROVIDER_NAME);
  });

  test("the consent small print is where the consent dialog names it", () => {
    expect(POWERFUL_CONSENT_SMALL_PRINT).toContain(POWERFUL_PROVIDER_NAME);
  });

  test("the recorder, upload and Settings read one not-private line", () => {
    expect(FINAL_COPY.modes.powerfulExplanation).toBe(POWERFUL_NOT_PRIVATE_LINE);
    expect(routeText("assemblyai", "hosted")).toBe(POWERFUL_NOT_PRIVATE_LINE);
  });
});
