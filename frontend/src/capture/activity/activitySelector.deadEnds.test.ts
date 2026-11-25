// A line that says "Needs attention" must give the user something to do: an action or "Try again". While the app will try
// again by itself, no line of the note says "Needs attention": it is "Retrying" (with "Try now") or in progress.
import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { notePipeline, type NotePipelineInput, type PipelineDevice, type PipelineFailureKind, type PipelineOnDevice, type PipelineCloud, type PipelinePending } from "@/lib/voiceNotes/notePipeline";
import { transcriptRetryTarget, type NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { AppPlatform } from "@/lib/platform";
import type { LibraryItem } from "../library/LibraryRow";
import { ActivityNoteSection } from "./ActivityPanel";
import { activityForNote, type ActivityJob } from "./activitySelector";

const IDLE = { busy: false, depth: 0 };
const SAVED = { saved: true, pending: null, lane: IDLE } as const;
const done = (sync: PipelineOnDevice["sync"]): PipelineOnDevice => ({ stt: { state: "done", error: null }, queue: null, model: null, download: "idle", sync });

function macInput(patch: Partial<NotePipelineInput>): NotePipelineInput {
  return { device: "mac", route: "on-device", hasNotesOrMoments: false, online: true, capture: { finalizing: false, issue: null },
    space: SAVED, transcript: { inSpace: null, cloud: null, onDevice: done(null) }, notes: { state: "idle" }, ...patch };
}

/** A view as `useNotePipelines` makes it: every view has `onAction` and `onRetryStep`. */
function liveView(input: NotePipelineInput, calls: string[] = []): NotePipelineView {
  return { input, pipeline: notePipeline(input), provider: input.route === "on-device" ? "local" : input.route === "off" ? "off" : input.transcriptProvider ?? "private",
    route: input.route, onAction: (kind) => calls.push(`action:${kind}`), onRetryStep: (key) => calls.push(`step:${key}`), actionError: null };
}

const item: LibraryItem = { id: "note-1", source: "exo-voice-note", sourceId: "rec-1", title: "A note", startedAt: "2026-11-20T09:00:00Z", durationSecs: 60 };
/** The Activity panel's words for one note: the line labels, states, details and buttons. */
const panelText = (jobs: ActivityJob[]) => renderToStaticMarkup(createElement(ActivityNoteSection, { item, jobs, onOpenNote: () => {}, onClose: () => {} }))
  .replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const buttons = (jobs: ActivityJob[]) => [...renderToStaticMarkup(createElement(ActivityNoteSection, { item, jobs, onOpenNote: () => {}, onClose: () => {} }))
  .matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);

test("a failed write of a transcript the space already has keeps Try again, and Try again writes it again", () => {
  // After a relaunch while the space is down, the check of an already synced transcript fails; its transcript step is done.
  const calls: string[] = [];
  const input = macInput({ transcript: { inSpace: "transcribed", cloud: null, onDevice: done({ state: "failed", message: "Couldn't check this note on this Mac." }) } });
  const view = liveView(input, calls);
  const sync = activityForNote(view, "tauri").find((job) => job.kind === "sync");
  expect(sync?.state).toBe("needs-attention");
  expect(sync?.detail).toBe("Couldn't sync to your TinyCloud space.");
  expect(buttons(activityForNote(view, "tauri"))).toContain("Try again");
  (sync?.action?.run ?? sync?.retry)?.();
  // The transcript step's retry: with a finished local transcript it is the write, never a new transcription.
  expect(calls).toEqual(["step:transcript"]);
  expect(transcriptRetryTarget(input)).toBe("sync");
});

test("Try again on a transcript line never transcribes again while a finished local transcript exists", () => {
  for (const sync of [{ state: "syncing" }, { state: "synced" }, { state: "held", message: "full" }, { state: "failed", message: "x" }] as const) {
    for (const inSpace of [null, "transcribed"] as const) {
      expect(transcriptRetryTarget(macInput({ transcript: { inSpace, cloud: null, onDevice: done(sync) } })), `${sync.state}/${inSpace}`).toBe("sync");
      expect(transcriptRetryTarget(macInput({ device: "iphone", transcript: { inSpace, cloud: null, onDevice: done(sync) } })), `${sync.state}/${inSpace}`).toBe("sync");
    }
  }
});

test("while the next automatic save is scheduled, no line of the note needs attention; the Sync line has Try now", () => {
  const now = Date.now();
  const calls: string[] = [];
  // A save that failed before; the pipeline then set the next try (a retry waiting on the node, or the open's pass) and queued its upload.
  for (const kind of ["server", "timeout", "rejected", "other", "auth"] as const) {
    for (const upload of [{ state: "waiting", bytes: 0, total: 100 }, { state: "retrying", bytes: 0, total: 100 }] as const) {
      const input = macInput({ space: { saved: false, pending: { failed: { kind, message: "raw" }, retryAt: now + 30_000, upload }, lane: IDLE } });
      const jobs = activityForNote(liveView(input, calls), "tauri", now);
      expect(jobs.filter((job) => job.state === "needs-attention").map((job) => `${job.label}: ${job.detail}`), `${kind}/${upload.state}`).toEqual([]);
      const sync = jobs.find((job) => job.kind === "sync");
      expect(sync?.state).toBe("retrying");
      expect(sync?.action?.label).toBe("Try now");
      expect(jobs.find((job) => job.kind === "upload-audio")?.state).toBe(upload.state === "retrying" ? "retrying" : "waiting");
      expect(panelText(jobs)).not.toContain("Needs attention");
    }
  }
});

test("a transcript write that will be tried again by itself is Retrying with Try now, which writes it", () => {
  const now = Date.now();
  for (const inSpace of [null, "transcribed"] as const) {
    const calls: string[] = [];
    const input = macInput({ transcript: { inSpace, cloud: null, onDevice: done({ state: "failed", message: "Couldn't add the transcript to this note.", retryAt: now + 120_000 }) } });
    const view = liveView(input, calls);
    expect(view.pipeline.steps.find((step) => step.key === "transcript")?.state).not.toBe("failed");
    const jobs = activityForNote(view, "tauri", now);
    expect(jobs.filter((job) => job.state === "needs-attention")).toEqual([]);
    const sync = jobs.find((job) => job.kind === "sync");
    expect(sync?.state).toBe("retrying");
    expect(sync?.detail).toBe("Your TinyCloud space is slow to answer · trying again in 120 s");
    expect(sync?.action?.label).toBe("Try now");
    sync?.action?.run();
    expect(calls).toEqual(["step:transcript"]);
    expect(transcriptRetryTarget(input)).toBe("sync");
    // Once the time has passed with no answer, the line is the failure again, with its Try again.
    const late = activityForNote(liveView(macInput({ transcript: { inSpace, cloud: null, onDevice: done({ state: "failed", message: "x", retryAt: now - 1 }) } })), "tauri", now)
      .find((job) => job.kind === "sync");
    expect(late?.state).toBe("needs-attention");
    expect(late?.action ?? late?.retry).toBeDefined();
  }
});

// --- The invariant ---------------------------------------------------------------------------------------------

/**
 * The true dead ends: there is nothing a button could do from here, and the line says where the recording is.
 * Each returns its name, or null when the job is not that dead end.
 */
const DEAD_ENDS: { name: string; matches: (job: ActivityJob, input: NotePipelineInput, platform: AppPlatform) => boolean }[] = [
  // The recording itself could not be finished; its pieces are kept on the device (PHONE_COPY.recoveryFailed / writeFailed).
  { name: "recording could not be finished", matches: (job, input) => job.kind === "finish" && (input.capture.issue === "recoveryFailed" || input.capture.issue === "quarantined" || input.capture.issue === "write_failed") },
  // The audio cannot be read (unreadable, too large, corrupt): saving again cannot help (failure kind "source", no action by design).
  { name: "recording cannot be read", matches: (job, input) => (job.kind === "sync" || job.kind === "upload-audio") && input.space.pending?.failed?.kind === "source" },
  // The transcription provider refused this note for good (not retryable); the note page offers another provider.
  { name: "transcription refused for good", matches: (job, input) => job.kind === "transcribe" && input.transcript.cloud?.kind === "failed" && !input.transcript.cloud.retryable },
  // Storage is full on an iPhone or Android phone: the app may not open a purchase page there, and the line says where the plan is managed.
  { name: "storage full on a phone app", matches: (job, input, platform) => (platform === "ios" || platform === "android")
    && ((job.kind === "upload-audio" && input.space.pending?.failed?.kind === "quota") || (job.kind === "sync" && input.transcript.onDevice?.sync?.state === "held")) },
];

function* shapes(now: number): Generator<NotePipelineInput> {
  const devices: PipelineDevice[] = ["mac", "iphone", "android", "browser"];
  const failures: (PipelineFailureKind | undefined)[] = [undefined, "offline", "rejected", "timeout", "quota", "auth", "server", "source", "other"];
  const uploads: PipelinePending["upload"][] = [undefined, { state: "waiting", bytes: 0, total: 10 }, { state: "preparing", bytes: 0, total: 10 }, { state: "uploading", bytes: 4, total: 10 }, { state: "retrying", bytes: 4, total: 10 }];
  const retries = [undefined, now + 60_000, now - 1_000];
  const spaces: NotePipelineInput["space"][] = [SAVED, { saved: true, localOnly: true, pending: null, lane: IDLE }, { saved: false, pending: null, lane: IDLE }];
  for (const kind of failures) for (const upload of uploads) for (const retryAt of retries) {
    spaces.push({ saved: false, pending: { ...(kind ? { failed: { kind, message: "raw" } } : {}), ...(upload ? { upload } : {}), ...(retryAt ? { retryAt } : {}) }, lane: IDLE });
  }
  for (const held of ["signed-out", "other-account", "legacy", "unowned"] as const) spaces.push({ saved: false, pending: { held, failed: { kind: "server", message: "raw" } }, lane: IDLE });
  const syncs: PipelineOnDevice["sync"][] = [null, { state: "syncing" }, { state: "synced" }, { state: "failed", message: "raw" }, { state: "failed", message: "raw", retryAt: now + 60_000 },
    { state: "failed", message: "raw", retryAt: now - 1_000 }, { state: "unrecorded", message: "raw" }, { state: "held", message: "raw" }];
  const stts: PipelineOnDevice["stt"][] = [null, { state: "waiting_for_model", error: null }, { state: "queued", error: null }, { state: "running", error: null }, { state: "done", error: null }, { state: "failed", error: "raw" }, { state: "cancelled", error: null }];
  const onDevices: PipelineOnDevice[] = [];
  for (const stt of stts) for (const sync of syncs) onDevices.push({ stt, queue: null, model: null, download: "idle", sync });
  onDevices.push({ stt: null, queue: null, model: { state: "failed", bytes: 0, totalBytes: 1, error: "raw" }, download: "failed", sync: null },
    { stt: { state: "waiting_for_model", error: null }, queue: null, model: { state: "absent", bytes: 0, totalBytes: 1, error: null }, download: "idle", sync: null });
  const clouds: PipelineCloud[] = [{ kind: "active", status: { kind: "processing", completed: 1, total: 2 } }, { kind: "done", outcome: "transcribed" },
    { kind: "failed", code: "server_error", message: "raw", retryable: true, reference: null }, { kind: "failed", code: "rejected", message: "raw", retryable: false, reference: null },
    { kind: "failed", code: "storage_full", message: "raw", retryable: true, reference: null }, { kind: "held", message: "raw" },
    ...(["checking", "unavailable", "check-failed", "no-consent", "limits-unknown", "limits-exceeded"] as const).map((reason): PipelineCloud => ({ kind: "blocked", reason }))];
  const transcripts: NotePipelineInput["transcript"][] = [];
  for (const inSpace of [null, "transcribed"] as const) {
    for (const onDevice of onDevices) transcripts.push({ inSpace, cloud: null, onDevice });
    for (const cloud of [null, ...clouds]) transcripts.push({ inSpace, cloud, onDevice: null });
    transcripts.push({ inSpace, cloud: null, onDevice: null, readError: "raw" });
  }
  for (const device of devices) for (const space of spaces) for (const transcript of transcripts) {
    const route = transcript.onDevice ? "on-device" : transcript.cloud || transcript.readError ? "private-cloud" : "off";
    yield { device, route, transcriptProvider: "private", hasNotesOrMoments: false, online: true, capture: { finalizing: false, issue: null }, space, transcript, notes: { state: "idle" } };
  }
  // The rest of the note around a few saves: capture, connection and the notes step.
  const captures: NotePipelineInput["capture"][] = [{ finalizing: true, issue: null }, ...(["finalization_timed_out", "recoveryFailed", "quarantined", "write_failed", "partial_audio"] as const)
    .map((issue) => ({ finalizing: false, issue })), { finalizing: false, issue: null, readError: "raw" }];
  const notes: NotePipelineInput["notes"][] = [{ state: "idle" }, { state: "syncing" }, { state: "synced" }, { state: "failed" }, { state: "skipped", reason: "no-row" }, { state: "unreadable", cause: "raw" }];
  for (const device of devices) for (const capture of [{ finalizing: false, issue: null }, ...captures]) for (const note of notes) for (const online of [true, false])
    for (const space of [SAVED, spaces[3]!, { saved: false, pending: { failed: { kind: "timeout" as const, message: "raw" }, retryAt: now + 60_000 }, lane: IDLE }]) {
      yield { device, route: "on-device", hasNotesOrMoments: true, online, capture, space, transcript: { inSpace: null, cloud: null, onDevice: done(null) }, notes: note };
    }
}

const PLATFORM: Record<PipelineDevice, AppPlatform> = { mac: "tauri", iphone: "ios", phone: "ios", android: "android", browser: "web" };

test("every line that needs attention has an action or Try again, except the named dead ends", () => {
  const now = Date.now();
  const offenders = new Map<string, string>();
  const used = new Set<string>();
  let count = 0;
  for (const input of shapes(now)) {
    const platform = PLATFORM[input.device];
    const view = liveView(input);
    // A receipt can have its pipeline before its input: the same rule holds there.
    const { input: _input, ...early } = view;
    for (const [shape, current] of [["input", view], ["no input", early]] as const) {
      for (const job of activityForNote(current, platform, now)) {
        count++;
        if (job.state !== "needs-attention" || job.action || job.retry) continue;
        const deadEnd = DEAD_ENDS.find((entry) => entry.matches(job, input, platform));
        if (deadEnd) { used.add(deadEnd.name); continue; }
        const key = `${job.label}: ${job.detail}`;
        if (!offenders.has(key)) offenders.set(key, `${shape} · ${JSON.stringify(input)}`);
      }
    }
  }
  expect(count).toBeGreaterThan(10_000);
  expect([...offenders].map(([line, shape]) => `${line}\n  ${shape}`)).toEqual([]);
  // Each named dead end is a real one the shapes reach; a name that matches nothing is not a dead end any more.
  expect([...used].sort()).toEqual(DEAD_ENDS.map((entry) => entry.name).sort());
});

test("while a save or a transcript write is scheduled to try again by itself, no line needs attention", () => {
  const now = Date.now();
  const offenders: string[] = [];
  for (const input of shapes(now)) {
    const saveScheduled = (input.space.pending?.retryAt ?? 0) > now;
    const writeScheduled = input.transcript.onDevice?.sync?.state === "failed" && (input.transcript.onDevice.sync.retryAt ?? 0) > now;
    if (!(saveScheduled || writeScheduled) || input.space.pending?.held || input.capture.issue || input.capture.readError || input.notes.state !== "idle" && input.notes.state !== "synced") continue;
    for (const job of activityForNote(liveView(input), PLATFORM[input.device], now)) {
      // Lines the scheduled attempt is about: the save of the note (its Sync and Upload audio lines) and the write of its
      // transcript. A transcript this device could not record (`unrecorded`) is a failure of its own, with its own action.
      const transcriptLine = job.failureCode?.startsWith("transcript-") === true;
      const ownLine = (saveScheduled && !input.space.saved && (job.kind === "upload-audio" || (job.kind === "sync" && !transcriptLine)))
        || (writeScheduled && job.kind === "sync" && job.failureCode === "transcript-sync-failed");
      if (ownLine && job.state === "needs-attention") offenders.push(`${job.label}: ${job.detail} · ${JSON.stringify(input)}`);
    }
  }
  expect(offenders.slice(0, 5)).toEqual([]);
});
