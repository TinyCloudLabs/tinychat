// The Upload and Meeting sheets' views and Capture's In progress rows
// (TC-761), rendered on the server: what each state says and offers.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { AudioUploadView, type AudioUploadViewProps } from "@/chat/AudioUploadPanel";
import { TranscriberView } from "@/chat/TranscriberSection";
import type { UploadState } from "@/lib/audioUpload";
import type { TranscriberMeeting } from "@/lib/transcriberApi";
import { InProgressRowsView, type InProgressRowsViewProps } from "./InProgressRows";
import { uploadRoute } from "./sheetRoute";

const noop = () => {};

function upload(patch: Partial<UploadState> = {}): UploadState {
  return {
    engine: "private-cloud",
    fileName: "Interview.m4a",
    stage: "uploading",
    uploadPct: 42,
    detail: null,
    audio: { stage: "storing", pct: 10 },
    error: null,
    savedTitle: null,
    cleanupPending: false,
    ...patch,
  };
}

function meeting(patch: Partial<TranscriberMeeting> = {}): TranscriberMeeting {
  return {
    id: "mtg_1",
    status: "in_progress",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    created_at: "2026-10-06T09:00:00.000Z",
    ...patch,
  };
}

function renderUpload(patch: Partial<AudioUploadViewProps>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AudioUploadView
        job={null}
        file={null}
        engine="private-cloud"
        engines={{ "private-cloud": { state: "available" }, assemblyai: { state: "available" } }}
        diarize
        diarizeUnavailable={null}
        fileProblem={null}
        onEngineChange={noop}
        onDiarizeChange={noop}
        onFile={noop}
        onTranscribe={noop}
        onRetry={noop}
        onDismiss={noop}
        onOpenSettings={noop}
        onRecheck={noop}
        {...patch}
      />
    </MemoryRouter>,
  );
}

function renderRows(patch: Partial<InProgressRowsViewProps>): string {
  return renderToStaticMarkup(
    <InProgressRowsView
      upload={null}
      paused={null}
      meetings={[]}
      busyId={null}
      onOpenUpload={noop}
      onContinue={noop}
      onOpenMeeting={noop}
      onEnd={noop}
      {...patch}
    />,
  );
}

describe("Upload sheet", () => {
  test("choose: a file, the route control, the route and one line, then Transcribe", () => {
    const html = renderUpload({});
    expect(html).toContain("Choose an audio file");
    expect(html).toContain(">Transcription</h3>");
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("This device");
    expect(html).toContain("Private cloud");
    expect(html).toContain("Your space");
    expect(html).toContain('href="/chat/about#uploads"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Transcribe<\/button>/);
  });

  test("paused: the stored file and Continue; nothing else to fill in", () => {
    const html = renderUpload({ paused: { fileName: "Interview.m4a" } });
    expect(html).toContain('data-testid="upload-paused"');
    expect(html).toContain("Interview.m4a");
    expect(html).toContain("Upload paused. This upload uses your own AssemblyAI key. Continue to unlock it and finish.");
    expect(html).toContain(">Continue</button>");
    expect(html).not.toContain(">Transcribe</button>");
  });

  test("uploading: progress on the route, not landed yet", () => {
    const html = renderUpload({ job: upload() });
    expect(html).toContain("Uploading to Private cloud… 42%");
    expect(html).toContain('aria-label="Where your audio goes"');
    expect(html).not.toContain("data-landed");
    expect(html).not.toContain(">Discard</button>");
  });

  test("landed: the receipt, with the route's last node checked", () => {
    const html = renderUpload({
      job: upload({ stage: "saved", savedTitle: "Interview", audio: { stage: "stored", pct: 100 } }),
      onOpenLibrary: noop,
    });
    expect(html).toContain("Saved to your TinyCloud space");
    expect(html).toContain("Interview · Private cloud");
    expect(html).toContain("data-landed");
    expect(html).toContain("(saved)");
    expect(html).toContain(">Open Library</button>");
    expect(html).toContain(">Upload another file</button>");
  });

  test("the route names whose AssemblyAI account", () => {
    expect(uploadRoute("assemblyai", "hosted").map((n) => n.label)).toEqual(["This device", "AssemblyAI · TinyCloud's account", "Your space"]);
    expect(uploadRoute("assemblyai", "own")[1].label).toBe("AssemblyAI · your key");
    expect(uploadRoute("private-cloud", "own")[1].label).toBe("Private cloud");
  });
});

describe("Meeting sheet", () => {
  const base = {
    listStatus: "ready" as const,
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
  };
  const render = (patch: object) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <TranscriberView {...base} meetings={[]} {...patch} />
      </MemoryRouter>,
    );

  test("the link, an optional name, the route and Send; then the sessions with End and Remove", () => {
    const html = render({ meetings: [meeting(), meeting({ id: "mtg_2", status: "completed" })] });
    expect(html).toContain(">Meeting link</label>");
    expect(html).toContain(">Notetaker name (optional)</label>");
    expect(html).toContain("TinyCloud notetaker");
    expect(html).toContain(">Send notetaker</span>");
    expect(html).toContain(">Sessions</h3>");
    expect(html).toContain("<span>End</span>");
    expect(html).toContain(">Remove</button>");
  });

  test("dark: no form and no sessions, and says why", () => {
    const html = render({ listStatus: "dark" });
    expect(html).not.toContain('id="transcriber-meeting-url"');
    expect(html).not.toContain(">Sessions</h3>");
    expect(html).toContain("TRANSCRIPTION_API_URL");
  });
});

describe("In progress", () => {
  test("nothing moving: no section at all", () => {
    expect(renderRows({})).toBe("");
  });

  test("an upload shows its stage; a paused one offers Continue beside its row", () => {
    const busy = renderRows({ upload: upload() });
    expect(busy).toContain(">In progress</h2>");
    expect(busy).toContain("Interview.m4a");
    expect(busy).toContain("Uploading to Private cloud… 42%");
    const paused = renderRows({ paused: { fileName: "Interview.m4a" } });
    expect(paused).toContain("Upload paused");
    expect(paused).toContain(">Continue</button>");
    // A running upload wins over a stale paused one.
    expect(renderRows({ upload: upload(), paused: { fileName: "Old.m4a" } })).not.toContain("Old.m4a");
    expect(renderRows({ upload: upload({ stage: "saved", savedTitle: "Interview" }) })).toContain("Saved to your space");
  });

  test("a notetaker in a meeting can be ended from its row; one transcribing cannot", () => {
    const live = renderRows({ meetings: [meeting()] });
    expect(live).toContain("meet.google.com/abc-defg-hij");
    expect(live).toContain("Notetaker · In meeting");
    expect(live).toContain('aria-label="End meeting and transcribe now"');
    const processing = renderRows({ meetings: [meeting({ status: "processing" })] });
    expect(processing).toContain("Notetaker · Transcribing");
    expect(processing).not.toContain("End meeting and transcribe now");
    expect(renderRows({ meetings: [meeting()], busyId: "mtg_1" })).toContain("Ending…");
  });
});
