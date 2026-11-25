import { describe, expect, test } from "bun:test";
import { createFakeDesktopCaptureExtras } from "@/lib/voiceNotes/fakeDesktopCaptureExtras";
import { chooseSystemAudio, needsSystemAudioDisclosure, SYSTEM_AUDIO_BODY, SYSTEM_AUDIO_MIC_ONLY, SYSTEM_AUDIO_RECORD, SYSTEM_AUDIO_TITLE } from "./systemAudioDisclosure";

describe("Mac system audio disclosure", () => {
  test("exact copy describes separate channels and the start or resume rule", () => {
    expect(SYSTEM_AUDIO_TITLE).toBe("Also record this Mac's audio?");
    expect(SYSTEM_AUDIO_BODY).toBe("TinyCloud One can record everything this Mac plays, such as the other side of calls, videos and notifications, as Them alongside your mic as Me. Turning it off applies when you resume. Turning it on applies to your next recording.");
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

// Names in the call are read only while this Mac's audio is recorded too, so "Mic only" also turns that setting off.
describe("Mac system audio disclosure, with names in the call", () => {
  test("Mic only also turns off reading names from the call window, after the Mac's audio", async () => {
    const fake = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true, permission: "granted" } });
    await chooseSystemAudio(fake.extras, "mic-only");
    expect(fake.calls).toEqual(["systemAudio.set:false", "callNames.set:false", "systemAudioConsent.set:true"]);
    expect(await fake.extras.callNames!.get()).toEqual({ enabled: false, permission: "granted" });
  });

  test("recording this Mac's audio leaves the names setting as it is", async () => {
    const fake = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true, permission: "granted" } });
    await chooseSystemAudio(fake.extras, "record");
    expect(fake.calls).toEqual(["systemAudioConsent.set:true"]);
    expect(await fake.extras.callNames!.get()).toEqual({ enabled: true, permission: "granted" });
  });

  test("a names setting that fails, or never answers, does not hold up or undo the choice", async () => {
    const failing = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true } });
    failing.failNext("callNames.set", "denied");
    await chooseSystemAudio(failing.extras, "mic-only");
    expect(await failing.extras.systemAudio.get()).toBe(false);
    expect(await failing.extras.systemAudioConsent.get()).toBe(true);

    const silent = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true } });
    silent.extras.callNames!.set = () => new Promise<void>(() => {});
    await chooseSystemAudio(silent.extras, "mic-only");
    expect(await silent.extras.systemAudioConsent.get()).toBe(true);

    const throwing = createFakeDesktopCaptureExtras({ systemAudio: true, callNames: { enabled: true } });
    throwing.extras.callNames!.set = () => { throw new Error("gone"); };
    await chooseSystemAudio(throwing.extras, "mic-only");
    expect(await throwing.extras.systemAudioConsent.get()).toBe(true);
  });

  test("where the app has no names in the call, Mic only is as it was", async () => {
    const fake = createFakeDesktopCaptureExtras({ systemAudio: true });
    await chooseSystemAudio(fake.extras, "mic-only");
    expect(fake.calls).toEqual(["systemAudio.set:false", "systemAudioConsent.set:true"]);
  });
});
