import { describe, expect, test } from "bun:test";
import { createFakeVoiceNotes } from "./fakeVoiceNotes";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";

const code = (value: string) => expect.objectContaining({ code: value });
const legacy = (id: string): VoiceNoteRecording => ({ id, startedAt: 1, durationMs: 1000, mimeType: "audio/mp4", sizeBytes: 100,
  silencedMs: 0, silencedEvents: 0, noSignalMs: 0 });

describe("VoiceNotes v2 fake public contract", () => {
  test("record, pause with mic off, resume in a new generation, and commit recorded time", async () => {
    let clock = 1000;
    const { plugin, controls } = createFakeVoiceNotes(() => clock);
    const start = await plugin.start();
    controls.tick(2000); clock += 2000;
    await plugin.pause();
    expect(await plugin.status()).toMatchObject({ state: "paused", intent: "paused", audioMs: 2000 });
    clock += 5000;
    expect((await plugin.status()).elapsedMs).toBe(2000);
    await plugin.resume();
    controls.tick(2000); clock += 2000;
    const note = await plugin.stop();
    expect(note).toMatchObject({ id: start.id, durationMs: 4000, wallMs: 9000, pausedMs: 5000, owner: null, version: 2 });
    expect(note.spans).toEqual([]);
  });

  test("the interruption, restart, backoff, manual Resume and notification cells", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    const { id } = await plugin.start();
    controls.interruptionBegins("call");
    expect(await plugin.status()).toMatchObject({ state: "interrupted", availability: "interrupted", openSpan: { kind: "omitted", reason: "interruption" } });
    const notification = controls.pendingNotification();
    expect(notification?.id).toBe(id);
    controls.interruptionEnds(false);
    expect((await plugin.status()).state).toBe("interrupted");
    expect(controls.backoffDelayMs()).toBe(500);
    controls.retryAutomatic(false);
    expect(controls.backoffDelayMs()).toBe(1000);
    await plugin.resume();
    expect(await plugin.status()).toMatchObject({ state: "recording", availability: "available", openSpan: null });
    expect(controls.pendingNotification()).toBeNull();
    controls.deliverNotification(notification!.id, notification!.gen);
    expect((await plugin.status()).state).toBe("recording");
    controls.interruptionBegins();
    controls.backoffExhausted();
    expect((await plugin.status()).state).toBe("needs_user");
    controls.appActive();
    expect((await plugin.status()).state).toBe("recording");
  });

  test("paused interruption and delayed callbacks cannot reacquire the microphone", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    await plugin.start();
    controls.interruptionBegins();
    const notification = controls.pendingNotification()!;
    await plugin.pause();
    controls.interruptionEnds();
    controls.appActive();
    controls.deliverNotification(notification.id, notification.gen);
    controls.completeRestart(notification.gen, true);
    expect(await plugin.status()).toMatchObject({ state: "paused", intent: "paused", openSpan: null });
    expect(controls.pendingNotification()).toBeNull();
    await plugin.resume();
    expect((await plugin.status()).state).toBe("recording");
  });

  test.each(["routeChange", "mediaReset", "stall"] as const)("%s opens a typed gap only while recording", async (event) => {
    const { plugin, controls } = createFakeVoiceNotes();
    await plugin.start();
    controls[event]();
    expect(await plugin.status()).toMatchObject({ state: "recording", openSpan: null });
    expect((await plugin.status()).spans).toHaveLength(1);
    await plugin.pause();
    controls[event]();
    expect((await plugin.status()).spans).toHaveLength(1);
  });

  test("silence writes frames; suspension opens a missing span; permission loss commits", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    await plugin.start();
    controls.silence(true); controls.tick(500);
    expect((await plugin.status()).state).toBe("silenced");
    controls.silence(false);
    controls.appSuspended();
    expect((await plugin.status()).openSpan?.reason).toBe("app_suspended");
    controls.appActive();
    controls.permissionRevoked();
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ silencedMs: 500, endedUnexpectedly: true });
  });

  test("Stop and Discard cancel notifications; stale completion cannot restart", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    const first = await plugin.start();
    controls.interruptionBegins();
    const gen = controls.pendingNotification()!.gen;
    await plugin.stop();
    controls.completeRestart(gen, true);
    controls.deliverNotification(first.id, gen);
    expect((await plugin.status()).state).toBe("idle");
    await plugin.start();
    controls.interruptionBegins();
    const discard = await plugin.discard();
    expect(controls.tombstoned(discard.id!)).toBe(true);
    expect(controls.pendingNotification()).toBeNull();
  });

  test("the three-hour limit excludes pauses but counts interruption time", async () => {
    let clock = 0;
    const { plugin, controls } = createFakeVoiceNotes(() => clock);
    await plugin.start({ maxDurationMs: 10_000 });
    clock = 4000; controls.tick(4000);
    await plugin.pause();
    clock = 14_000;
    await plugin.resume();
    controls.interruptionBegins();
    clock = 20_000; controls.tick(0);
    // No frames during the call, but wallMs - pausedMs has reached the limit.
    controls.interruptionEnds();
    controls.tick(0);
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ durationMs: 4000, pausedMs: 10_000 });
  });

  test("paused table cells keep input released and Stop or Discard still work", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    await plugin.start();
    await plugin.pause();
    controls.interruptionBegins();
    expect(controls.pendingNotification()).toBeNull();
    expect((await plugin.status()).spans).toEqual([]);
    controls.routeChange(); controls.mediaReset(); controls.stall(); controls.silence(true); controls.appSuspended(); controls.appActive();
    expect((await plugin.status()).state).toBe("paused");
    expect((await plugin.status()).spans).toEqual([]);
    await plugin.stop();
    expect((await plugin.status()).state).toBe("idle");
    await plugin.start(); await plugin.pause();
    const { id } = await plugin.discard();
    expect(controls.tombstoned(id!)).toBe(true);
  });

  test("a native shortcut start emits presentRecorder", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    const presented: string[] = [];
    await plugin.addListener("presentRecorder", (event) => presented.push(event.id));
    const id = await controls.startFromSource("quick_action");
    expect(presented).toEqual([id]);
    expect((await plugin.status()).source).toBe("quick_action");
  });

  test("a late listener receives the retained mic state", async () => {
    const { plugin } = createFakeVoiceNotes();
    await plugin.start();
    const states: string[] = [];
    await plugin.addListener("micState", (event) => states.push(event.state));
    await Promise.resolve();
    expect(states).toEqual(["recording"]);
  });

  test("defaults claim signed-out v2 only, reject stale transition and protect account ownership", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    const first = await plugin.start({ transcriber: "assemblyai" });
    expect((await plugin.status()).options?.transcriber).toBe("on-device");
    const saved = await plugin.stop();
    const second = await plugin.start();
    controls.commitLegacy(legacy("legacy"));
    const claimed = await plugin.setCaptureDefaults({ accountDid: "did:A", transitionGen: 5, transcriber: "assemblyai", identifySpeakers: false });
    expect(claimed.claimed).toEqual([second.id, first.id]);
    expect((await plugin.listPending()).recordings.find((n) => n.id === saved.id)?.owner).toBe("did:A");
    expect((await plugin.listPending()).recordings.find((n) => n.id === "legacy")?.owner).toBeNull();
    await expect(plugin.setCaptureDefaults({ accountDid: "did:B", transitionGen: 4, transcriber: "assemblyai", identifySpeakers: false })).rejects.toEqual(code("stale_transition"));
    await expect(plugin.claim({ id: saved.id, did: "did:B", evidence: "signed_out_v2" })).rejects.toEqual(code("owner_mismatch"));
  });

  test("legacy claim requires space row or user choice; space row means audio already saved", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    controls.commitLegacy(legacy("legacy"));
    await expect(plugin.claim({ id: "legacy", did: "did:A", evidence: "signed_out_v2" })).rejects.toEqual(code("claim_evidence_required"));
    await plugin.claim({ id: "legacy", did: "did:A", evidence: "space_row" });
    expect((await plugin.listPending()).recordings[0]).toMatchObject({ owner: "did:A", ownerUnknown: false, ledger: { audio: { state: "saved" } } });
    controls.commitLegacy(legacy("legacy-2"));
    await plugin.claim({ id: "legacy-2", did: "did:A", evidence: "user_choice" });
    expect((await plugin.listPending()).recordings.find((note) => note.id === "legacy-2")?.ledger).toBeUndefined();
  });

  test("ledger CAS, owner check, tombstone refusal and durable cleanup outbox", async () => {
    const { plugin, controls } = createFakeVoiceNotes();
    await plugin.setCaptureDefaults({ accountDid: "did:A", transitionGen: 1, transcriber: "on-device", identifySpeakers: false });
    const { id } = await plugin.start();
    await plugin.stop();
    await expect(plugin.updateLedger({ id, did: "did:B", rev: 1, patch: {} })).rejects.toEqual(code("owner_mismatch"));
    expect(await plugin.updateLedger({ id, did: "did:A", rev: 1, patch: { audio: { state: "saved", rowId: `vn-${id}`, at: 1 } } })).toEqual({ rev: 2 });
    await expect(plugin.updateLedger({ id, did: "did:A", rev: 1, patch: {} })).rejects.toEqual(code("rev_conflict"));
    controls.addRemote(id, { provider: "assemblyai", mode: "hosted", stage: "uploading", uploadId: "up-1", uploadUrl: null, jobId: null, cleanup: "pending" });
    await plugin.deleteAudio({ id });
    expect((await plugin.listOutbox({ did: "did:A" })).entries).toMatchObject([{ kind: "hosted_upload", handle: "up-1" }]);
    expect((await plugin.listOutbox({ did: "did:B" })).entries).toEqual([]);
    const entryId = (await plugin.listOutbox({ did: "did:A" })).entries[0].entryId;
    await plugin.completeOutbox({ entryId, result: "retry" });
    expect((await plugin.listOutbox({ did: "did:A" })).entries[0].attempts).toBe(1);
    await plugin.completeOutbox({ entryId, result: "done" });
    expect((await plugin.listOutbox({ did: "did:A" })).entries).toEqual([]);
    await expect(plugin.updateLedger({ id, did: "did:A", rev: 2, patch: {} })).rejects.toEqual(code("tombstoned"));
    await expect(plugin.putTranscript({ id, transcript: {} as never })).rejects.toEqual(code("tombstoned"));
    await expect(plugin.claim({ id, did: "did:A", evidence: "signed_out_v2" })).rejects.toEqual(code("tombstoned"));
    expect(() => controls.commitLegacy(legacy(id))).toThrow("tombstoned");
  });
});
