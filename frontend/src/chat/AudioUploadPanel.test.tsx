// Upload audio surfaces, asserted against real markup (react-dom/server, as in
// TranscriberSection.test.tsx):
//   1. Upload audio is a Transcriber tab wherever a space is signed in; Local recording only with its panel;
//   2. an engine that can't take the upload says why and Transcribe stays off;
//   3. speaker identification is off, with a reason, when the engine can't do it;
//   4. disclosures never claim more than they may, and AssemblyAI's says Exo deletes its copy;
//   5. a stored-audio failure is told beside the saved transcript; a failure offers Retry only when it can help;
//   6. Settings keeps the key in a password field, and offers removal once saved.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { assemblyAiStatus, AudioUploadView, fileProblem, type AudioUploadViewProps } from "./AudioUploadPanel";
import { TranscriberView } from "./TranscriberSection";
import { TranscriptionSettingsView, type TranscriptionSettingsViewProps } from "./TranscriptionSettings";
import type { UploadState } from "@/lib/audioUpload";

const noop = () => {};

function renderUpload(patch: Partial<AudioUploadViewProps> = {}): string {
  const props: AudioUploadViewProps = {
    job: null,
    file: { name: "standup.mp3", type: "audio/mpeg", size: 3_000_000 },
    engine: "private-cloud",
    engines: { "private-cloud": { state: "available" }, assemblyai: { state: "available" } },
    diarize: true,
    diarizeUnavailable: null,
    fileProblem: null,
    onEngineChange: noop,
    onDiarizeChange: noop,
    onFile: noop,
    onTranscribe: noop,
    onRetry: noop,
    onDismiss: noop,
    onOpenSettings: noop,
    onRecheck: noop,
    ...patch,
  };
  return renderToStaticMarkup(<AudioUploadView {...props} />);
}

function job(patch: Partial<UploadState> = {}): UploadState {
  return {
    engine: "assemblyai",
    fileName: "standup.mp3",
    stage: "saved",
    uploadPct: null,
    detail: null,
    audio: { stage: "stored", pct: 100 },
    error: null,
    savedTitle: "standup",
    cleanupPending: false,
    ...patch,
  };
}

const transcribeButton = /<button[^>]*>Transcribe<\/button>/;

describe("Transcriber tabs", () => {
  test("on the web, Upload audio sits beside the meeting bot and renders its own panel", () => {
    const base = {
      listStatus: "ready" as const,
      meetings: [],
      saved: {},
      form: { url: "", botName: "", submitting: false, error: null },
      busyId: null,
      open: null,
      onUrlChange: noop,
      onBotNameChange: noop,
      onSubmit: noop,
      onRefresh: noop,
      onStop: noop,
      onToggleTranscript: noop,
      onRemove: noop,
      onKindChange: noop,
      uploadPanel: <div>upload panel</div>,
    };
    const bot = renderToStaticMarkup(<TranscriberView {...base} kind="meeting-bot" />);
    expect(bot).toContain(">Upload audio</button>");
    expect(bot).not.toContain("Local recording");
    expect(bot).toContain('id="transcriber-meeting-url"');
    const upload = renderToStaticMarkup(<TranscriberView {...base} kind="upload" listStatus="dark" />);
    expect(upload).toContain("upload panel");
    expect(upload).not.toContain('id="transcriber-meeting-url"');
  });
});

describe("AudioUploadView", () => {
  test("an unavailable engine says why, links where it can be fixed, and Transcribe stays off", () => {
    const noOrigin = renderUpload({
      engines: {
        "private-cloud": { state: "unavailable", reason: "Private transcription isn't set up in this version of Exo yet." },
        assemblyai: { state: "available" },
      },
    });
    expect(noOrigin).toContain("isn&#x27;t set up in this version");
    expect(noOrigin).toMatch(/<button[^>]*disabled=""[^>]*>Transcribe<\/button>/);

    const noKey = renderUpload({
      engine: "assemblyai",
      engines: {
        "private-cloud": { state: "available" },
        assemblyai: { state: "unavailable", reason: "AssemblyAI needs your own API key.", action: "settings" },
      },
    });
    expect(noKey).toContain(">Open Settings</button>");
    expect(noKey).toMatch(/<button[^>]*disabled=""[^>]*>Transcribe<\/button>/);

    expect(renderUpload()).toMatch(transcribeButton);
    expect(renderUpload()).not.toMatch(/<button[^>]*disabled=""[^>]*>Transcribe<\/button>/);
  });

  test("speaker identification is ticked by default, and off with a reason when the engine can't do it", () => {
    expect(renderUpload()).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>Identify speakers \(diarization\)/);
    const off = renderUpload({ diarizeUnavailable: "Speaker identification isn't available for private transcription yet." });
    expect(off).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*\/>Identify speakers/);
    expect(off).not.toMatch(/checked=""/);
    expect(off).toContain("isn&#x27;t available for private transcription yet");
  });

  test("disclosures stay within what each party does; AssemblyAI's says Exo deletes its copy after saving", () => {
    const priv = renderUpload();
    const aai = renderUpload({ engine: "assemblyai", assemblyAiMode: "own" });
    const hosted = renderUpload({ engine: "assemblyai", assemblyAiMode: "hosted" });
    for (const html of [priv, aai, hosted]) expect(html).not.toMatch(/verified|attested|end-to-end/i);
    // TinyCloud's account: the file passes through Exo's server, and the copy says so.
    expect(hosted).toContain("Your file goes to Exo&#x27;s server (a confidential VM on Phala Cloud)");
    expect(hosted).toContain("under TinyCloud&#x27;s account");
    expect(hosted).toContain("Exo deletes it at AssemblyAI after saving");
    expect(hosted).not.toContain("your own API key");
    expect(priv).toContain("TinyCloud Private Transcription");
    expect(priv).toContain("never receives your audio");
    expect(aai).toContain("under your own API key");
    expect(aai).toContain("Exo deletes the copy at AssemblyAI");
    // The key goes through Exo's server once, for the delete; the copy says so.
    expect(aai).toContain("forwards your key to AssemblyAI once; it never stores or logs it");
  });

  test("a file private cloud can't take is named before anything is sent", () => {
    expect(fileProblem({ name: "clip.mov", type: "video/quicktime", size: 10 }, "private-cloud")).toContain("Choose AssemblyAI");
    expect(fileProblem({ name: "clip.mov", type: "video/quicktime", size: 10 }, "assemblyai", undefined, "own")).toBeNull();
    // TinyCloud's AssemblyAI account goes through Exo's server, which takes the same audio types.
    expect(fileProblem({ name: "clip.mov", type: "video/quicktime", size: 10 }, "assemblyai", undefined, "hosted")).toContain("your own AssemblyAI key");
    expect(fileProblem({ name: "long.wav", type: "audio/wav", size: 200_000_000 }, "private-cloud")).toContain("up to");
    const html = renderUpload({ fileProblem: "Private transcription takes MP3…" });
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Transcribe<\/button>/);
  });

  test("a saved upload tells when its audio wasn't stored; failures offer Retry only when it can help", () => {
    const quota = renderUpload({ job: job({ audio: { stage: "quota", pct: null } }) });
    expect(quota).toContain("Saved to Library as");
    expect(quota).toContain("storage is full. The transcript was saved without it.");
    expect(quota).toContain(">Upload another file</button>");

    const retryable = renderUpload({ job: job({ stage: "failed", error: { message: "Couldn't save the transcript.", reference: "c-1", retry: true } }) });
    expect(retryable).toContain('role="alert"');
    expect(retryable).toContain(">Retry</button>");
    expect(retryable).toContain("Reference: c-1");
    const final = renderUpload({ job: job({ stage: "failed", error: { message: "Choose the file again.", reference: null, retry: false } }) });
    expect(final).not.toContain(">Retry</button>");
    expect(final).toContain(">Discard</button>");

    const running = renderUpload({ job: job({ stage: "uploading", uploadPct: 42, audio: { stage: "storing", pct: 10 } }) });
    expect(running).toContain("Uploading to AssemblyAI… 42%");
    expect(running).toContain("Storing the original audio in your space… 10%");
    expect(running).not.toContain(">Discard</button>");
  });
});

describe("TranscriptionSettingsView", () => {
  const render = (patch: Partial<TranscriptionSettingsViewProps> = {}) =>
    renderToStaticMarkup(
      <TranscriptionSettingsView
        engine="private-cloud"
        keyStatus="none"
        keyMode="hosted"
        onKeyModeChange={noop}
        phase="idle"
        keyInput=""
        error={null}
        onEngineChange={noop}
        onKeyInputChange={noop}
        onSaveKey={noop}
        onRemoveKey={noop}
        onCheckKey={noop}
        {...patch}
      />,
    );

  test("the key is entered in a password field and can be removed once saved; Private is the default engine", () => {
    const none = render({ keyMode: "own" });
    expect(none).toMatch(/<input id="assemblyai-api-key" type="password"/);
    expect(none).toMatch(/role="radio" aria-checked="true"[^>]*>Private</);
    expect(none).not.toContain("Remove key");
    const saved = render({ keyStatus: "saved", keyMode: "own" });
    expect(saved).toContain("Remove key");
    expect(saved).not.toContain('id="assemblyai-api-key"');
    // TinyCloud's account is the default and needs no key field.
    const hostedMode = render();
    expect(hostedMode).toMatch(/role="radio" aria-checked="true"[^>]*>TinyCloud&#x27;s AssemblyAI account</);
    expect(hostedMode).not.toContain('id="assemblyai-api-key"');
  });
});

describe("assemblyAiStatus", () => {
  test("TinyCloud's account is offered only when the server says it has it; the own key only when one is saved", () => {
    expect(assemblyAiStatus("hosted", { state: "ok", caps: { hosted: true } }, "none")).toEqual({ state: "available" });
    const dark = assemblyAiStatus("hosted", { state: "ok", caps: { hosted: false } }, "saved");
    expect(dark).toMatchObject({ state: "unavailable", action: "settings" });
    expect(dark.state === "unavailable" && dark.reason).toContain("your own AssemblyAI key");
    expect(assemblyAiStatus("hosted", { state: "failed" }, "saved")).toMatchObject({ state: "unavailable", action: "recheck" });
    expect(assemblyAiStatus("hosted", { state: "checking" }, "saved")).toEqual({ state: "checking" });
    expect(assemblyAiStatus("own", { state: "ok", caps: { hosted: true } }, "none")).toMatchObject({ state: "unavailable", action: "settings" });
    expect(assemblyAiStatus("own", { state: "failed" }, "saved")).toEqual({ state: "available" });
  });
});
