// TC-2131: a hosted (Powerful) transcription AssemblyAI is holding back shows as a calm in-progress state, never a failure:
//   1. the client keeps polling a `delayed` upload (slowly, with the long limit) and reports it, then carries on;
//   2. Monica's words are fixed constants with no provider name; the voice-note row and the activity line use the row,
//      the upload sheet uses the title and body; Private's own wording is untouched.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// Pin HOME to a ticket temp dir before anything can write (nothing here should write at all).
const HOME = mkdtempSync(join("/var/tmp", "tc-2131."));
appendFileSync("/var/tmp/tc-2131-mktemp-list.txt", `${HOME}\n`);
process.env.HOME = HOME;
if (process.env.HOME !== HOME || !HOME.startsWith("/var/tmp/tc-2131.")) throw new Error("test HOME is not the ticket temp dir");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { activityForNote, noteStatus } from "@/capture/activity/activitySelector";
import { AudioUploadView, uploadStatusText, type AudioUploadViewProps } from "@/chat/AudioUploadPanel";
import type { UploadState } from "@/lib/audioUpload";
import { AssemblyAiError, createHostedAssemblyAiClient } from "./assemblyai";
import { notePipeline, type NotePipelineInput } from "./voiceNotes/notePipeline";
import {
  HOSTED_DELAYED_ROW,
  HOSTED_DELAYED_SHEET_BODY,
  HOSTED_DELAYED_SHEET_TITLE,
  PROVIDER_DELAYED_COPY,
} from "./voiceNotes/notePipelineCopy";
import type { NotePipelineView } from "./voiceNotes/useNotePipeline";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Monica's words", () => {
  test("are exactly these, and name no provider", () => {
    expect([HOSTED_DELAYED_SHEET_TITLE, HOSTED_DELAYED_SHEET_BODY, HOSTED_DELAYED_ROW]).toEqual([
      "Transcription delayed",
      "It will finish automatically. You don't need to do anything.",
      "Transcription delayed · finishes automatically",
    ]);
    for (const words of [HOSTED_DELAYED_SHEET_TITLE, HOSTED_DELAYED_SHEET_BODY, HOSTED_DELAYED_ROW]) {
      expect(words).not.toMatch(/assembly|powerful|private|tinfoil|whisper/i);
    }
  });
});

describe("the hosted client keeps polling a delayed upload", () => {
  function client(states: ({ status: string; id?: string; retry_after_seconds?: number; error?: unknown })[]) {
    const sleeps: number[] = [];
    const queue = [...states];
    const c = createHostedAssemblyAiClient({
      backendUrl: "https://api.example",
      sessionStore: { getToken: () => "tok", isExpired: () => false },
      fetchImpl: (async () => json(202, queue.shift())) as never,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    return { c, sleeps, left: () => queue.length };
  }

  test("delayed is in progress: polled every 15 s (not 2 s) with onDelayed true, then false when it is submitted", async () => {
    const { c, sleeps, left } = client([
      { status: "submitting" },
      { status: "delayed", retry_after_seconds: 60 },
      { status: "delayed", retry_after_seconds: 30 },
      { status: "submitting" },
      { status: "submitted", id: "aah1.x.y" },
    ]);
    const seen: boolean[] = [];
    expect(await c.createTranscript("aau_1", { speakerLabels: true, onDelayed: (delayed) => seen.push(delayed) })).toEqual({ id: "aah1.x.y", status: "queued" });
    expect(seen).toEqual([true, false]);
    // Each wait follows the state the last answer reported: fast, then slow while delayed, then fast again.
    expect(sleeps).toEqual([2_000, 15_000, 15_000, 2_000]);
    expect(left()).toBe(0);
  });

  test("a submission that is already delayed when it is first answered is reported at once, and a delayed job never throws", async () => {
    const { c, sleeps } = client(Array.from({ length: 40 }, () => ({ status: "delayed" })).concat([{ status: "submitted", id: "aah1.x.y" } as never]));
    const seen: boolean[] = [];
    const result = await c.createTranscript("aau_1", { speakerLabels: true, onDelayed: (delayed) => seen.push(delayed) });
    expect(result.id).toBe("aah1.x.y");
    expect(seen).toEqual([true, false]);
    expect(new Set(sleeps)).toEqual(new Set([15_000]));
  });

  test("a delayed job that finally fails is the ordinary failure, not a hang", async () => {
    const { c } = client([{ status: "delayed" }, { status: "failed", error: { code: "assemblyai_unavailable" } }]);
    const error = await c.createTranscript("aau_1", { speakerLabels: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssemblyAiError);
    expect((error as AssemblyAiError).kind).toBe("failed");
  });

  test("a client that has no onDelayed still waits (the sheet and the note both get the answer)", async () => {
    const { c } = client([{ status: "delayed" }, { status: "submitted", id: "aah1.x.y" }]);
    expect((await c.createTranscript("aau_1", { speakerLabels: true })).id).toBe("aah1.x.y");
  });
});

function pipelineInput(provider: NotePipelineInput["transcriptProvider"]): NotePipelineInput {
  return {
    device: "phone", route: "private-cloud", hasNotesOrMoments: false, online: true,
    capture: { finalizing: false, issue: null },
    space: { saved: true, pending: null, lane: { busy: false, depth: 0 } },
    transcript: { inSpace: null, onDevice: null, cloud: { kind: "active", status: { kind: "delayed" } } },
    notes: { state: "idle" },
    transcriptProvider: provider,
  };
}

describe("a delayed note shows the row for Powerful and keeps Private's wording", () => {
  test("the pipeline step: Monica's row for Powerful, Sam's line for Private; neither is a failure or offers Retry", () => {
    for (const [provider, caption] of [["powerful", HOSTED_DELAYED_ROW], ["private", PROVIDER_DELAYED_COPY]] as const) {
      const pipeline = notePipeline(pipelineInput(provider));
      const step = pipeline.steps.find((s) => s.key === "transcript");
      expect(step).toMatchObject({ state: "active", caption });
      expect(step?.blocker).toBeUndefined();
      expect(pipeline.blocker).toBeUndefined();
    }
  });

  test("the activity line says the same, as progress", () => {
    for (const [provider, detail] of [["powerful", HOSTED_DELAYED_ROW], ["private", PROVIDER_DELAYED_COPY]] as const) {
      const input = pipelineInput(provider);
      const view: NotePipelineView = { input, pipeline: notePipeline(input), provider, onAction: () => {}, actionError: null };
      const jobs = activityForNote(view, "ios");
      expect(jobs.find((job) => job.kind === "transcribe")).toMatchObject({ detail, state: "running" });
      expect(noteStatus(jobs)).not.toMatch(/fail|retry|attention/i);
    }
  });
});

describe("the upload sheet", () => {
  const noop = () => {};
  function render(job: UploadState): string {
    const props: AudioUploadViewProps = {
      job, file: null, engine: "assemblyai",
      engines: { "private-cloud": { state: "available" }, assemblyai: { state: "available" } },
      diarize: true, diarizeUnavailable: null, fileProblem: null,
      onEngineChange: noop, onDiarizeChange: noop, onFile: noop, onTranscribe: noop, onRetry: noop, onDismiss: noop, onOpenSettings: noop, onRecheck: noop,
    };
    return renderToStaticMarkup(<MemoryRouter><AudioUploadView {...props} /></MemoryRouter>);
  }
  const base: UploadState = {
    engine: "assemblyai", assemblyAiMode: "hosted", fileName: "standup.mp3", stage: "queued", uploadPct: null, detail: "Sending the file to AssemblyAI…",
    audio: { stage: "stored", pct: 100 }, error: null, savedTitle: null, cleanupPending: false,
  };

  test("a delayed upload shows the title and body, no failure, no Retry, no Discard", () => {
    const html = render({ ...base, delayed: true, detail: HOSTED_DELAYED_ROW });
    expect(html).toContain('data-testid="upload-delayed"');
    expect(html).toContain(HOSTED_DELAYED_SHEET_TITLE);
    expect(html).toContain(HOSTED_DELAYED_SHEET_BODY.replace("'", "&#x27;"));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("Retry");
    expect(html).not.toContain("Discard");
    expect(html).not.toContain("Sending the file to AssemblyAI");
  });

  test("its In progress row is the one line; an upload that is not delayed reads as before", () => {
    expect(uploadStatusText({ ...base, delayed: true })).toBe(HOSTED_DELAYED_ROW);
    expect(uploadStatusText(base)).toBe("Sending the file to AssemblyAI…");
    expect(render(base)).not.toContain('data-testid="upload-delayed"');
    expect(render({ ...base, delayed: false })).toContain("Sending the file to AssemblyAI");
  });
});
