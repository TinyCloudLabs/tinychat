import { expect, test } from "bun:test";
import { notePipeline, type NotePipelineInput } from "@/lib/voiceNotes/notePipeline";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { UploadState } from "@/lib/audioUpload";
import { STORAGE_FULL_SAVE_MESSAGE } from "@/lib/storageStatus";
import { activityForFileUpload, activityForNote, deviceName, noteStatus, type ActivityKind, type ActivityState } from "./activitySelector";

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
  expect(failed.find((job) => job.kind === "sync")?.detail).toBe("Saving timed out. This note is safe on this Mac.");
  expect(failed.find((job) => job.kind === "sync")?.retry).toBeFunction();
  expect(JSON.stringify(failed.map((job) => job.detail))).not.toContain("secret/path");
});

test("Powerful is named separately from Private; devices are exact", () => {
  // Existing provider status uses processing for the remote phase.
  const transcript = { inSpace: null, onDevice: null, cloud: { kind: "active" as const, status: { kind: "processing" as const, completed: null, total: null } } };
  const powerful = activityForNote(view({ route: "private-cloud", space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript }, "powerful"), "web");
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

test("durable transcript outcomes have honest note statuses without phantom Activity jobs", () => {
  const cases = [
    { state: "pending", expected: "Transcript Pending" },
    { state: "failed", expected: "Transcript Failed · Private Transcription returned a transcript that may be incomplete. Try again later." },
    { state: "skipped", expected: "Transcript Not transcribed" },
  ] as const;
  for (const { state, expected } of cases) {
    const current = view({
      route: "off",
      space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
      transcript: { inSpace: null, persistedState: state, errorCode: state === "failed" ? "transcript_incomplete" : null, cloud: null, onDevice: null },
    });
    const jobs = activityForNote(current, "ios");
    expect(jobs).toEqual([]);
    expect(noteStatus(jobs, current.pipeline)).toBe(expected);
    if (state === "failed") expect(noteStatus(jobs, current.pipeline, false)).toBe("Transcript Failed");
  }
  const syncing = view({
    route: "off",
    hasNotesOrMoments: true,
    space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, persistedState: "failed", errorCode: "transcript_incomplete", cloud: null, onDevice: null },
    notes: { state: "syncing" },
  });
  // Notes sync can run independently of the durable transcript outcome.
  expect(noteStatus(activityForNote(syncing, "ios"), syncing.pipeline)).toContain("Transcript Failed");
});

test("finish, model wait, known local queue and wrong account use distinct copy", () => {
  const finishing = activityForNote(view({ capture: { finalizing: true, issue: null } }), "ios");
  expect(finishing.find((job) => job.kind === "finish")?.detail).toBe("Finishing the recording…");
  const model = activityForNote(view({ transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "waiting_for_model", error: null }, queue: null, model: { state: "absent", bytes: 0, totalBytes: 100 }, download: "waiting_for_network", sync: null } } }), "ios");
  expect(model.find((job) => job.kind === "transcribe")?.detail).toBe("Waiting for Wi-Fi to get the speech model");
  const queued = activityForNote(view({ transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "queued", error: null }, queue: { position: 1, inLine: 2, percent: null }, model: null, download: "idle", sync: null } } }), "android");
  expect(queued.find((job) => job.kind === "transcribe")?.detail).toBe("Next to transcribe");
  const account = activityForNote(view({ space: { saved: false, pending: { held: "other-account" }, lane: { busy: false, depth: 0 } } }), "web");
  expect(account.find((job) => job.kind === "sync")?.detail).toBe("Recorded on another account");
  expect(account.find((job) => job.kind === "sync")?.retry).toBeUndefined();
});

test("a local queue position is one-based, including the first Mac Whisper job", () => {
  const local = (position: number) => activityForNote(view({ transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "queued", error: null }, queue: { position, inLine: 3, percent: null }, model: null, download: "idle", sync: null } } }), "tauri").find((job) => job.kind === "transcribe");
  expect(local(1)?.detail).toBe("Next to transcribe");
  expect(local(3)?.detail).toBe("Waiting to transcribe · 2 notes ahead");
});

test("blocked conditions wait with the real reason and existing action", () => {
  const cases: { name: string; input: Partial<NotePipelineInput>; provider?: NotePipelineView["provider"]; kind: ActivityKind; action?: string; reason: string }[] = [
    { name: "sign in", input: { space: { saved: false, pending: { held: "signed-out" }, lane: { busy: false, depth: 0 } } }, kind: "sync", action: "Sign in", reason: "You're signed out" },
    { name: "another account", input: { space: { saved: false, pending: { held: "other-account" }, lane: { busy: false, depth: 0 } } }, kind: "sync", reason: "Recorded on another account" },
    { name: "model", input: { space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "waiting_for_model", error: null }, queue: null, model: { state: "absent", bytes: 0, totalBytes: 10, error: null }, download: "idle", sync: null } } }, kind: "transcribe", action: "Get model", reason: "need the on-device model" },
    { name: "check failed", input: { route: "private-cloud", space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "blocked", reason: "check-failed" } } }, provider: "private", kind: "transcribe", action: "Check again", reason: "Couldn't check whether private transcription is available" },
    { name: "consent", input: { route: "private-cloud", space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, onDevice: null, cloud: { kind: "blocked", reason: "no-consent" } } }, provider: "private", kind: "transcribe", action: "Review consent", reason: "Waiting for your OK to use Private" },
  ];
  for (const row of cases) {
    const calls: string[] = [];
    const current = view(row.input, row.provider ?? "local");
    current.onAction = (kind) => calls.push(kind);
    const job = activityForNote(current, "ios").find((entry) => entry.kind === row.kind);
    expect(job?.state, row.name).toBe("waiting");
    expect(job?.detail.includes(row.reason), row.name).toBe(true);
    expect(job?.action?.label, row.name).toBe(row.action);
    job?.action?.run();
    if (row.action) expect(calls).toHaveLength(1);
  }
});

test("offline never masks a recorded sync failure", () => {
  const jobs = activityForNote(view({ online: false, space: { saved: false, pending: { failed: { kind: "timeout", message: "secret/path" } }, lane: { busy: false, depth: 0 } } }), "tauri");
  const sync = jobs.find((job) => job.kind === "sync");
  expect(sync?.state).toBe("needs-attention");
  expect(sync?.detail).toContain("Saving timed out");
  expect(sync?.action?.label).toBe("Try again");
  expect(JSON.stringify(jobs.map((job) => job.detail))).not.toContain("secret/path");
});

test("Private and Powerful queues, preparation, and failure name the right provider", () => {
  const cloud = (kind: "waiting" | "preparing" | "queued" | "processing" | "failed") => kind === "failed" ? { kind: "failed" as const, code: "server_error", message: "raw", retryable: true, reference: "ref-7" } : { kind: "active" as const, status: kind === "waiting" ? { kind, position: 2 } as const : kind === "queued" ? { kind, position: 2 } as const : kind === "processing" ? { kind, completed: 1, total: 3 } as const : { kind } as const };
  for (const provider of ["private", "powerful"] as const) for (const phase of ["waiting", "preparing", "queued", "processing", "failed"] as const) {
    const current = view({ route: "private-cloud", transcriptProvider: provider, space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, onDevice: null, cloud: cloud(phase) } }, provider);
    const job = activityForNote(current, "web").find((entry) => entry.kind === "transcribe");
    expect(job?.state).toBe(phase === "failed" ? "needs-attention" : phase === "waiting" || phase === "queued" ? "waiting" : "running");
    expect(job?.detail.includes(provider === "powerful" ? "Private" : "Powerful")).toBe(false);
    if (phase === "failed") expect(job?.diagnostics).toContain("ref-7");
  }
});

test("a slow sync is retrying with Try now, and an upload retry is retrying", () => {
  const calls: string[] = [];
  const retryAt = 1_000_030_000;
  const slow = view({ space: { saved: false, pending: { retryAt }, lane: { busy: false, depth: 0 } } });
  slow.onRetryStep = (key) => calls.push(key);
  const sync = activityForNote(slow, "tauri", 1_000_000_000).find((job) => job.kind === "sync");
  expect(sync?.state).toBe("retrying");
  expect(sync?.detail).toBe("Your TinyCloud space is slow to answer · trying again in 30 s");
  expect(sync?.action?.label).toBe("Try now");
  sync?.action?.run();
  expect(calls).toEqual(["space"]);
  const upload = activityForNote(view({ space: { saved: false, pending: { upload: { state: "retrying", bytes: 4, total: 10 } }, lane: { busy: false, depth: 0 } } }), "ios").find((job) => job.kind === "upload-audio");
  expect(upload?.state).toBe("retrying");
  expect(upload?.detail).toBe("Retrying audio upload…");
});

test("unrecorded local sync is visible and local-only audio intent suppresses upload", () => {
  const unrecorded = activityForNote(view({ space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: "transcribed", cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync: { state: "unrecorded", message: "raw path" } } } }), "tauri");
  expect(unrecorded.find((job) => job.kind === "sync")?.state).toBe("needs-attention");
  expect(JSON.stringify(unrecorded.map((job) => job.detail))).not.toContain("raw path");
  const localOnly = activityForNote(view({ audioUploadIntent: false }), "tauri");
  expect(localOnly.some((job) => job.kind === "upload-audio")).toBe(false);
});

test("each voice job kind has running, waiting and attention fixtures", () => {
  const base = { saved: true, pending: null, lane: { busy: false, depth: 0 } } as const;
  const scenarios: { kind: ActivityKind; state: ActivityState; copy: string; patch: Partial<NotePipelineInput> }[] = [
    { kind: "finish", state: "running", copy: "Finishing the recording…", patch: { capture: { finalizing: true, issue: null } } },
    { kind: "finish", state: "waiting", copy: "Exo will finish it next launch", patch: { capture: { finalizing: false, issue: "finalization_timed_out" } } },
    { kind: "finish", state: "needs-attention", copy: "Couldn't finish this recording. Its pieces are kept on this Mac.", patch: { capture: { finalizing: false, issue: "write_failed" } } },
    { kind: "transcribe", state: "running", copy: "Transcribing on this Mac · 30%", patch: {} },
    { kind: "transcribe", state: "waiting", copy: "Waiting to transcribe · 1 note ahead", patch: { transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "queued", error: null }, queue: { position: 2, inLine: 2, percent: null }, model: null, download: "idle", sync: null } } } },
    { kind: "transcribe", state: "needs-attention", copy: "Couldn't transcribe on this Mac", patch: { transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "failed", error: "raw" }, queue: null, model: null, download: "idle", sync: null } } } },
    { kind: "sync", state: "running", copy: "Syncing to your TinyCloud space…", patch: { space: base, hasNotesOrMoments: true, notes: { state: "syncing" } } },
    { kind: "sync", state: "waiting", copy: "Waiting for a connection · syncs by itself", patch: { online: false, space: { saved: false, pending: {}, lane: { busy: false, depth: 0 } } } },
    { kind: "sync", state: "needs-attention", copy: "Your space couldn't take this note. It is safe on this Mac. Try again.", patch: { space: { saved: false, pending: { failed: { kind: "server", message: "raw" } }, lane: { busy: false, depth: 0 } } } },
    { kind: "upload-audio", state: "running", copy: "Uploading audio to your TinyCloud space · 40%", patch: {} },
    { kind: "upload-audio", state: "waiting", copy: "Waiting to upload audio", patch: { space: { saved: false, pending: { upload: { state: "waiting", bytes: 0, total: 10 } }, lane: { busy: false, depth: 0 } } } },
    { kind: "upload-audio", state: "needs-attention", copy: "Couldn't upload the audio. It's safe on this Mac.", patch: { space: { saved: false, pending: { upload: { state: "waiting", bytes: 0, total: 10 }, failed: { kind: "server", message: "raw" } }, lane: { busy: false, depth: 0 } } } },
  ];
  for (const { kind, state, copy, patch } of scenarios) {
    const job = activityForNote(view(patch), "tauri").find((entry) => entry.kind === kind);
    expect(job?.state, `${kind}/${state}`).toBe(state);
    expect(job?.detail, `${kind}/${state}`).toBe(copy);
    expect(job?.destination.length ?? 0).toBeGreaterThan(0);
  }
});

test("file import covers paused, uploading, queued, saving, failed and audio storage", () => {
  const actions = { open: () => {}, continue: () => {}, retry: () => {} };
  const base: UploadState = { engine: "assemblyai", fileName: "Interview.m4a", stage: "uploading", uploadPct: 42, detail: null, audio: { stage: "storing", pct: 10 }, error: null, savedTitle: null, cleanupPending: false };
  expect(activityForFileUpload(null, { fileName: base.fileName }, actions)?.jobs[0]?.action?.label).toBe("Continue");
  for (const [stage, state, kind] of [["uploading", "running", "upload-audio"], ["queued", "waiting", "transcribe"], ["transcribing", "running", "transcribe"], ["saving", "running", "sync"], ["failed", "needs-attention", "upload-audio"]] as const) {
    const item = activityForFileUpload({ ...base, stage, error: stage === "failed" ? { message: "raw", reference: "ref-2", retry: true } : null }, null, actions);
    expect(item?.title).toBe("Interview.m4a");
    expect(item?.jobs[0]?.state).toBe(state);
    expect(item?.jobs[0]?.kind).toBe(kind);
  }
  expect(activityForFileUpload({ ...base, stage: "saved", audio: { stage: "stored", pct: 100 } }, null, actions)).toBeNull();
  expect(activityForFileUpload({ ...base, stage: "saved", audio: { stage: "failed", pct: null } }, null, actions)?.jobs[0]?.state).toBe("needs-attention");
});

test("storage-full sync failure shows approved Details copy, never the raw quota code", () => {
  const jobs = activityForNote(view({ space: { saved: false, pending: { failed: { kind: "quota", message: "STORAGE_QUOTA_EXCEEDED: full" } }, lane: { busy: false, depth: 0 } } }), "tauri");
  const sync = jobs.find((job) => job.kind === "sync");
  expect(sync?.diagnostics).toBe(STORAGE_FULL_SAVE_MESSAGE);
  expect(JSON.stringify(jobs.map((job) => job.diagnostics))).not.toContain("STORAGE_QUOTA_EXCEEDED");
});

test("a transcript held by full storage is Manage storage on the sync job, with no second transcribe job", () => {
  const jobs = activityForNote(view({ space: { saved: true, pending: null, lane: { busy: false, depth: 0 } }, transcript: { inSpace: null, cloud: null, onDevice: { stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync: { state: "held", message: "x" } } } }), "tauri");
  expect(jobs.filter((job) => job.kind === "transcribe")).toEqual([]);
  expect(jobs.find((job) => job.kind === "sync")?.state).toBe("needs-attention");
  expect(jobs.find((job) => job.kind === "sync")?.action?.label).toBe("Manage storage");
});
