// Upload audio surfaces, asserted against real markup (react-dom/server, as in
// TranscriberSection.test.tsx):
//   1. Upload is a Capture action that opens its own sheet (no Transcriber tabs);
//   2. an engine that can't take the upload says why and Transcribe stays off;
//   3. speaker identification is off, with a reason, when the engine can't do it;
//   4. the route says where the file goes in one line, never more than the mechanism, and
//      a device's first private cloud upload says what Private cloud does in one sentence;
//   5. a stored-audio failure is told beside the saved transcript; a failure offers Retry only when it can help;
//   6. Settings offers the hosted Powerful engine without a key field.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import { SoftActions } from "@/capture/home/SoftActions";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { AboutPage } from "./AboutPage";
import { assemblyAiStatus, AudioUploadView, fileProblem, PRIVATE_CONSENT_TEXT, privateConsentAccountDid, type AudioUploadViewProps } from "./AudioUploadPanel";
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
    const hosted = renderUpload({ engine: "assemblyai", assemblyAiMode: "hosted" });
    for (const html of [priv, hosted]) {
      expect(html).not.toMatch(/verified|attested|end-to-end/i);
      expect(html).toContain('aria-label="Where your audio goes"');
      expect(html).toContain('href="/chat/about#uploads"');
      // The route control is a radio group (Private · Powerful).
      expect(html).toContain('role="radiogroup"');
      expect(html).toContain(">Private<");
      expect(html).toContain(">Powerful<");
      expect(html).not.toContain(">Private cloud<");
      expect(html).toContain(">This browser<");
    }
    // TinyCloud's account: the file passes through Exo's server, and the line says so.
    expect(hosted).toContain("Sent through Exo&#x27;s server to AssemblyAI under TinyCloud&#x27;s account, then deleted there.");
    expect(hosted).toContain("Powerful · TinyCloud&#x27;s account");
    expect(hosted).not.toContain("your key");
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
    expect(transcription).toContain("your audio goes to Exo’s server (a confidential VM on Phala Cloud)");
    expect(transcription).toContain("under TinyCloud’s account and AssemblyAI’s terms");
    expect(transcription).toContain("Exo deletes it at AssemblyAI after saving the transcript to your TinyCloud space");
    expect(transcription).not.toContain("your own API key");
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
    expect(first).toContain(PRIVATE_CONSENT_TEXT.replaceAll("'", "&#x27;"));
    expect(PRIVATE_CONSENT_TEXT).toContain("a sealed hardware enclave");
    expect(first).toMatch(transcribeButton);
    // Once agreed, only the route line; never for AssemblyAI.
    expect(renderUpload()).not.toContain("upload-private-consent");
    expect(renderUpload({ privateConsent: false, engine: "assemblyai" })).not.toContain("upload-private-consent");
  });

  test("Private consent requires an account DID", () => {
    expect(() => privateConsentAccountDid(null)).toThrow("Private consent requires an account DID.");
    expect(privateConsentAccountDid("did:test:account")).toBe("did:test:account");
    try { privateConsentAccountDid(undefined); } catch (error) { expect((error as { code: string }).code).toBe("private_consent_account_missing"); }
  });

  test("a file private cloud can't take is named before anything is sent", () => {
    expect(fileProblem({ name: "clip.mov", type: "video/quicktime", size: 10 }, "private-cloud")).toContain("Choose Powerful");
    // TinyCloud's AssemblyAI account goes through Exo's server, which takes the same audio types.
    expect(fileProblem({ name: "clip.mov", type: "video/quicktime", size: 10 }, "assemblyai", undefined, "hosted")).toContain("Convert the file");
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
    expect(running).toContain("Uploading for Powerful transcription… 42%");
    expect(running).toContain("Storing the original audio in your space… 10%");
    expect(running).not.toContain(">Discard</button>");
  });
});

describe("Settings → Transcription", () => {
  test("offers Private and Powerful with no AssemblyAI key field", async () => {
    const { TranscriptionSettings } = await import("./TranscriptionSettings");
    const html = renderToStaticMarkup(<MemoryRouter><TranscriptionSettings tcw={null as never} /></MemoryRouter>);
    const radios = [...html.matchAll(/role="radio"[^>]*>([^<]*)</g)].map((match) => match[1]);
    expect(radios).toEqual([TRANSCRIBER_NAME["private-cloud"], TRANSCRIBER_NAME.assemblyai]);
    expect(html).not.toContain("assemblyai-api-key");
    expect(html).toContain("Exo&#x27;s server");
  });
});

describe("assemblyAiStatus", () => {
  test("Powerful is offered only when the server says it has the hosted account", () => {
    expect(assemblyAiStatus("hosted", { state: "ok", caps: { hosted: true } })).toEqual({ state: "available" });
    const dark = assemblyAiStatus("hosted", { state: "ok", caps: { hosted: false } });
    expect(dark).toMatchObject({ state: "unavailable", action: "recheck" });
    expect(assemblyAiStatus("hosted", { state: "failed" })).toMatchObject({ state: "unavailable", action: "recheck" });
    expect(assemblyAiStatus("hosted", { state: "checking" })).toEqual({ state: "checking" });
    expect(assemblyAiStatus("own", { state: "ok", caps: { hosted: true } })).toMatchObject({ state: "unavailable" });
  });
});


test("discard cleanup offers Retry deleting without claiming the meeting was saved", () => {
  const html = renderUpload({ job: job({ stage: "failed", cleanupPending: true, error: { message: "Retry deleting to finish discarding.", retry: true, reference: null } }) });
  expect(html).toContain("Retry deleting</button>");
  expect(html).not.toContain(">Retry</button>");
  expect(html).not.toContain("Saved to your TinyCloud space");
});
