import { describe, expect, test } from "bun:test";
import { createFakeDesktopCaptureExtras } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { chooseSystemAudio, needsSystemAudioDisclosure, SYSTEM_AUDIO_BODY, SYSTEM_AUDIO_MIC_ONLY, SYSTEM_AUDIO_RECORD, SYSTEM_AUDIO_TITLE } from "./systemAudioDisclosure";

describe("Mac system audio disclosure", () => {
  test("exact Build 1 copy describes mixed audio and the start or resume rule", () => {
    expect(SYSTEM_AUDIO_TITLE).toBe("Also record this Mac's audio?");
    expect(SYSTEM_AUDIO_BODY).toBe("Exo can record everything this Mac plays, such as the other side of calls, videos and notifications, as Them alongside your mic as Me. A note's channel layout is set when it starts; changes during a note apply to its next recording segment.");
    expect([SYSTEM_AUDIO_RECORD, SYSTEM_AUDIO_MIC_ONLY]).toEqual(["Record this Mac's audio", "Mic only"]);
  });

  test("fresh and existing enabled profiles without consent both need the sheet once", async () => {
    for (const _permissionAlreadyGranted of [false, true]) {
      const fake = createFakeDesktopCaptureExtras({ systemAudio: true, systemAudioConsent: false });
      expect(await needsSystemAudioDisclosure(fake.extras)).toBe(true);
      await chooseSystemAudio(fake.extras, "record");
      expect(await needsSystemAudioDisclosure(fake.extras)).toBe(false);
      expect(await fake.extras.systemAudio.get()).toBe(true);
    }
  });

  test("Mic only turns off system audio before saving consent", async () => {
    const fake = createFakeDesktopCaptureExtras({ systemAudio: true });
    await chooseSystemAudio(fake.extras, "mic-only");
    expect(fake.calls.slice(0, 2)).toEqual(["systemAudio.set:false", "systemAudioConsent.set:true"]);
    expect(await fake.extras.systemAudio.get()).toBe(false);
    expect(await fake.extras.systemAudioConsent.get()).toBe(true);
  });
});
