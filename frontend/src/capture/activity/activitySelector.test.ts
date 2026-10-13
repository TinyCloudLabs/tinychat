import { expect, test } from "bun:test";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import { activityForNote, deviceName, noteStatus } from "./activitySelector";

function view(patch: Partial<NotePipelineInput> = {}, provider: NotePipelineView["provider"] = "local"): NotePipelineView {
  const input: NotePipelineInput = {
    device: "mac", route: "on-device", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: false, pending: { upload: { state: "uploading", bytes: 40, total: 100 } }, lane: { busy: true, depth: 2 } },
    transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "running", error: null }, queue: { position: 0, inLine: 0, percent: 30 }, model: null, download: "idle", sync: null } },
    notes: { state: "idle" }, ...patch,
  };
  return { input, pipeline: notePipeline(input), provider, onAction: () => {}, actionError: null };
}

test("simultaneous transcription and audio upload have separate jobs and destinations", () => {
  const jobs = activityForNote(view(), "tauri");
  expect(jobs.map((job) => job.kind)).toEqual(["transcribe", "sync", "upload-audio"]);
  expect(jobs.find((job) => job.kind === "transcribe")?.detail).toBe("Transcribing on this Mac · 30%");
  expect(jobs.find((job) => job.kind === "upload-audio")?.detail).toBe("Uploading audio to your TinyCloud space · 40%");
  expect(noteStatus(jobs)).toBe("Transcribing · Uploading audio");
  expect(jobs.some((job) => job.detail.includes("next in line"))).toBe(false);
});

test("offline is waiting, and a failed sync has a real Retry", () => {
  const offline = activityForNote(view({ online: false, space: { saved: false, pending: {}, lane: { busy: false, depth: 0 } } }), "ios");
  expect(offline.find((job) => job.kind === "sync")?.detail).toBe("Waiting for a connection · syncs by itself");
  expect(offline.find((job) => job.kind === "sync")?.state).toBe("waiting");
  const failed = activityForNote(view({ space: { saved: false, pending: { failed: { kind: "timeout", message: "secret/path" } }, lane: { busy: false, depth: 0 } } }), "tauri");
  expect(failed.find((job) => job.kind === "sync")?.detail).toBe("Couldn't sync to your TinyCloud space.");
  expect(failed.find((job) => job.kind === "sync")?.retry).toBeFunction();
  expect(JSON.stringify(failed.map((job) => job.detail))).not.toContain("secret/path");
});

test("Powerful is named separately from Private; devices are exact", () => {
  // Existing provider status uses processing for the remote phase.
  const transcript = { inSpace: null, onDevice: null, cloud: { kind: "active" as const, status: { kind: "processing" as const, completed: null, total: null } } };
  const powerful = activityForNote(view({ route: "private-cloud", space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript }, "powerful"), "web");
  expect(powerful.find((job) => job.kind === "transcribe")?.destination).toBe("Powerful (AssemblyAI)");
  expect(powerful.find((job) => job.kind === "transcribe")?.detail).toBe("Transcribing with Powerful…");
  expect(deviceName("tauri")).toBe("this Mac");
  expect(deviceName("ios")).toBe("this iPhone");
  expect(deviceName("android")).toBe("this Android phone");
  expect(deviceName("web")).toBe("this browser");
});

test("a retained local transcript is represented as sync, not fresh transcription", () => {
  const jobs = activityForNote(view({ space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync: { state: "syncing" } } } }), "android");
  expect(jobs.some((job) => job.kind === "transcribe")).toBe(false);
  expect(jobs.find((job) => job.kind === "sync")?.detail).toBe("Syncing to your TinyCloud space…");
});

test("finish, model wait, known local queue and wrong account use distinct copy", () => {
  const finishing = activityForNote(view({ capture: { finalizing: true, issue: null } }), "ios");
  expect(finishing.find((job) => job.kind === "finish")?.detail).toBe("Finishing the recording…");
  const model = activityForNote(view({ transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "waiting_for_model", error: null }, queue: null, model: { state: "absent", bytes: 0, totalBytes: 100 }, download: "waiting_for_network", sync: null } } }), "ios");
  expect(model.find((job) => job.kind === "transcribe")?.detail).toBe("Waiting for Wi-Fi to get the speech model");
  const queued = activityForNote(view({ transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "queued", error: null }, queue: { position: 1, inLine: 2, percent: null }, model: null, download: "idle", sync: null } } }), "android");
  expect(queued.find((job) => job.kind === "transcribe")?.detail).toBe("Waiting to transcribe · 1 note ahead");
  const account = activityForNote(view({ space: { saved: false, pending: { held: "other-account" }, lane: { busy: false, depth: 0 } } }), "web");
  expect(account.find((job) => job.kind === "sync")?.detail).toBe("Recorded on another account");
  expect(account.find((job) => job.kind === "sync")?.retry).toBeUndefined();
});
