// Upload audio surfaces, asserted against real markup (react-dom/server, as in
// TranscriberSection.test.tsx):
//   1. Upload is a Capture action that opens its own sheet (no Transcriber tabs);
//   2. an engine that can't take the upload says why and Transcribe stays off;
//   3. speaker identification is off, with a reason, when the engine can't do it;
//   4. the route says where the file goes in one line, never more than the mechanism, and
//      a device's first private cloud upload says what Private cloud does in one sentence;
//   5. a stored-audio failure is told beside the saved transcript; a failure offers Retry only when it can help;
//   6. Settings keeps the key in a password field, and offers removal once saved.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { SoftActions } from "@/capture/home/SoftActions";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { AboutPage } from "./AboutPage";
import { assemblyAiStatus, AudioUploadView, fileProblem, PRIVATE_CONSENT_TEXT, type AudioUploadViewProps } from "./AudioUploadPanel";
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
  return renderToStaticMarkup(
    <MemoryRouter>
      <AudioUploadView {...props} />
    </MemoryRouter>,
  );
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

describe("Upload on Capture", () => {
  test("Upload is a Capture action that opens its own sheet, on every platform; the Transcriber tabs are gone", () => {
    const actions = renderToStaticMarkup(<StaticRecorderProvider value={{ available: false }}><SoftActions onUpload={noop} onMeeting={noop} /></StaticRecorderProvider>);
    expect(actions).toContain('aria-label="Upload audio"');
    expect(actions).toContain('aria-label="Send a notetaker to a meeting"');
    // No notetaker on this backend: no Meeting action, Upload stays.
    const dark = renderToStaticMarkup(<StaticRecorderProvider value={{ available: false }}><SoftActions onUpload={noop} /></StaticRecorderProvider>);
    expect(dark).toContain('aria-label="Upload audio"');
    expect(dark).not.toContain("Send a notetaker");
    const capture = readFileSync(join(import.meta.dir, "../capture/CaptureSurface.tsx"), "utf8");
    expect(capture).toContain('onUpload={() => setSheet("upload")}');
    expect(capture).toContain('<UploadSheet open={sheet === "upload"}');
    expect(capture).not.toContain("TranscriberSection ");
    const sheet = readFileSync(join(import.meta.dir, "../capture/upload/UploadSheet.tsx"), "utf8");
    expect(sheet).toContain("<ResponsiveSheet");
    expect(sheet).toContain("<AudioUploadPanel");
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

  test("the route says where the file goes in one line, within what each party does; How it works has the rest", () => {
    const priv = renderUpload();
    const aai = renderUpload({ engine: "assemblyai", assemblyAiMode: "own" });
    const hosted = renderUpload({ engine: "assemblyai", assemblyAiMode: "hosted" });
    for (const html of [priv, aai, hosted]) {
      expect(html).not.toMatch(/verified|attested|end-to-end/i);
      expect(html).toContain('aria-label="Where your audio goes"');
      expect(html).toContain('href="/chat/about#uploads"');
      // The route control is a radio group (Private cloud · AssemblyAI).
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain(">Private cloud<");
    }
    // TinyCloud's account: the file passes through Exo's server, and the line says so.
    expect(hosted).toContain("Sent through Exo&#x27;s server to AssemblyAI under TinyCloud&#x27;s account, then deleted there.");
    expect(hosted).toContain("AssemblyAI · TinyCloud&#x27;s account");
    expect(hosted).not.toContain("your key");
    expect(aai).toContain("Sent from this device to AssemblyAI with your key, then deleted there.");
    expect(aai).toContain("AssemblyAI · your key");
    expect(priv).toContain("Transcribed by TinyCloud Private Transcription. A copy of the file stays in your space.");
    // No disclosure paragraphs inline.
    expect(priv).not.toContain("confidential virtual machine");
  });

  test("the full disclosures live on How it works, which the sheet links to; they still never claim more than each party does", () => {
    // The sheet's link: the uploads section, which leads on to where the audio goes.
    expect(renderUpload()).toContain('href="/chat/about#uploads"');
    const about = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/chat/about"]}>
        <AboutPage onBack={noop} />
      </MemoryRouter>,
    );
    const section = (id: string) => {
      const start = about.indexOf(`<section id="${id}"`);
      expect(start).toBeGreaterThan(-1);
      return about.slice(start, about.indexOf("</section>", start));
    };
    const uploads = section("uploads");
    const transcription = section("transcription");
    expect(uploads).toContain('href="/chat/about#transcription"');
    for (const html of [uploads, transcription]) expect(html).not.toMatch(/verified|attested|end-to-end/i);
    // TinyCloud's AssemblyAI account: through Exo's server, under AssemblyAI's terms, deleted there after saving.
    expect(transcription).toContain("your file goes to Exo’s server (a confidential VM on Phala Cloud)");
    expect(transcription).toContain("under TinyCloud’s account and AssemblyAI’s terms");
    expect(transcription).toContain("Exo deletes it at AssemblyAI after saving the transcript to your TinyCloud space");
    // The user's own key: from this device, under their key and AssemblyAI's terms; the key passes Exo's server once, for the delete.
    expect(transcription).toContain("the file goes from this device to AssemblyAI under your key and AssemblyAI’s terms");
    expect(transcription).toContain("it does not pass through TinyChat’s server");
    expect(transcription).toContain("forwards the key there once; it never stores or logs it");
    expect(transcription).toContain("AssemblyAI is not part of TinyCloud’s private transcription");
    // Private cloud.
    expect(transcription).toContain("TinyCloud Private Transcription, a dedicated confidential virtual machine on Phala Cloud");
    expect(transcription).toContain("It sends short speech segments to Tinfoil for speech-to-text");
    expect(transcription).toContain("It never receives your audio");
    expect(transcription).toContain("An upload keeps a copy of the original file in your space, next to its transcript");
  });

  test("a device's first private cloud upload says what private cloud does, in one sentence, before Transcribe", () => {
    const first = renderUpload({ privateConsent: false });
    expect(first).toContain('data-testid="upload-private-consent"');
    expect(first).toContain(PRIVATE_CONSENT_TEXT);
    expect(PRIVATE_CONSENT_TEXT.split(". ")).toHaveLength(1);
    expect(first).toMatch(transcribeButton);
    // Once agreed, only the route line; never for AssemblyAI.
    expect(renderUpload()).not.toContain("upload-private-consent");
    expect(renderUpload({ privateConsent: false, engine: "assemblyai" })).not.toContain("upload-private-consent");
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
    const quota = renderUpload({ job: job({ audio: { stage: "quota", pct: null } }), onOpenLibrary: noop });
    // The receipt: where it landed, the route with its last node checked, and Open Library.
    expect(quota).toContain("Saved to your TinyCloud space");
    expect(quota).toContain("data-landed");
    expect(quota).toContain(">Open Library</button>");
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


test("discard cleanup offers Retry deleting without claiming the meeting was saved", () => {
  const html = renderUpload({ job: job({ stage: "failed", cleanupPending: true, error: { message: "Retry deleting to finish discarding.", retry: true, reference: null } }) });
  expect(html).toContain("Retry deleting</button>");
  expect(html).not.toContain(">Retry</button>");
  expect(html).not.toContain("Saved to your TinyCloud space");
});
