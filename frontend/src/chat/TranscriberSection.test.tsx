// The TRANSCRIBER card in Settings. `TranscriberView` is a pure function of its props, so every
// product rule is asserted against real markup via react-dom/server (same call as
// MeetingsSection.test.tsx: no DOM harness in this workspace). The client is asserted against
// an injected fetch. Rules:
//   1. dark (backend has no transcriber) says so and hides the form — never a blank card;
//   2. an outage/offline/signed-out list is TOLD, never rendered as "no meetings";
//   3. active meetings can end and transcribe now, completed ones show Transcript, terminal ones show Remove;
//   4. a transcript renders speaker-attributed segments;
//   5. the client sends bearer + CSRF header, maps 202 to pending and list-404 to feature-dark;
//   6. Settings mounts the section with the session and backend URL only.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import {
  TranscriberView,
  describeFailure,
  meetingTitle,
  statusLabel,
  type TranscriberViewProps,
} from "./TranscriberSection";
import {
  LocalTranscriberView,
  cloudProgressText,
  isLocalWorkflowActive,
  localFailureState,
  localRetryAction,
  type LocalTranscriberViewProps,
} from "./LocalTranscriber";
import {
  CaptureStopUnconfirmedError,
  CloudConnectionLostError,
  NO_SPEECH_MESSAGE,
  PartialRecordingError,
  PreviousCaptureUnconfirmedError,
  TranscriptionFailedError,
} from "@/lib/localTranscriber";
import {
  createTranscriberClient,
  type TranscriberMeeting,
  type TranscriberMeetingStatus,
} from "@/lib/transcriberApi";

function meeting(patch: Partial<TranscriberMeeting> = {}): TranscriberMeeting {
  return {
    id: "mtg_1",
    status: "queued",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    bot: { name: "TinyCloud Private Notetaker" },
    created_at: "2026-08-18T10:00:00.000Z",
    ...patch,
  };
}

const noop = () => {};

function render(patch: Partial<TranscriberViewProps> = {}): string {
  const props: TranscriberViewProps = {
    listStatus: "ready",
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
    ...patch,
  };
  return renderToStaticMarkup(<TranscriberView {...props} />);
}

describe("TranscriberView", () => {
  test("dark says the backend is not configured and hides the form", () => {
    const html = render({ listStatus: "dark" });
    expect(html).toContain("Transcriber");
    expect(html).toContain("isn&#x27;t configured");
    expect(html).toContain("TRANSCRIPTION_API_URL");
    expect(html).not.toContain("transcriber-meeting-url");
  });

  test("ready + empty shows the form and an empty-state hint", () => {
    const html = render();
    expect(html).toContain('id="transcriber-meeting-url"');
    expect(html).toContain("Send bot");
    expect(html).toContain("hears no one else for five minutes");
    expect(html).toContain("end it immediately");
    expect(html).toContain("No meetings yet");
  });

  test("outage, offline and signed-out are told, never rendered as empty", () => {
    for (const [status, phrase] of [
      ["unavailable", "temporarily unavailable"],
      ["offline", "offline"],
      ["signed-out", "session expired"],
    ] as const) {
      const html = render({ listStatus: status });
      expect(html).toContain(phrase);
      expect(html).not.toContain("No meetings yet");
    }
  });

  test("a form error is announced", () => {
    const html = render({ form: { url: "x", botName: "", submitting: false, error: "That doesn't look like a meeting link." } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("meeting link");
  });

  test("row actions follow the status: end and transcribe while active, Transcript when completed, Remove when settled", () => {
    const active = render({ meetings: [meeting({ status: "in_progress" })] });
    expect(active).toContain("In meeting");
    expect(active).toContain("End meeting &amp; transcribe now");
    expect(active).not.toContain(">Remove<");
    expect(active).not.toContain(">Transcript<");

    const processing = render({ meetings: [meeting({ status: "processing" })] });
    expect(processing).toContain("Transcribing");
    expect(processing).not.toContain("End meeting &amp; transcribe now");

    const done = render({ meetings: [meeting({ status: "completed" })] });
    expect(done).toContain(">Transcript<");
    expect(done).toContain(">Remove<");
    expect(done).not.toContain("End meeting &amp; transcribe now");

    const failed = render({
      meetings: [
        meeting({
          status: "failed",
          error: { type: "meeting_join_failed", code: "waiting_room_timeout", message: "Nobody admitted the bot." },
        }),
      ],
    });
    expect(failed).toContain("Failed");
    expect(failed).toContain("Nobody admitted the bot.");
    expect(failed).toContain(">Remove<");
  });

  test("ending a meeting shows immediate finalization feedback", () => {
    const html = render({
      meetings: [meeting({ status: "in_progress" })],
      busyId: "mtg_1",
    });
    expect(html).toContain("Ending &amp; transcribing…");
    expect(html).toContain("animate-spin");
    expect(html).toContain("disabled");
  });

  test("the row title is the meeting host + path, linked to the meeting", () => {
    const html = render({ meetings: [meeting()] });
    expect(html).toContain("meet.google.com/abc-defg-hij");
    expect(html).toContain('href="https://meet.google.com/abc-defg-hij"');
    expect(meetingTitle("https://meet.jit.si/room/")).toBe("meet.jit.si/room");
    expect(meetingTitle("garbage")).toBe("garbage");
  });

  test("an unavailable row keeps its id and can be removed", () => {
    const html = render({ meetings: [{ id: "mtg_x", unavailable: true }] });
    expect(html).toContain("mtg_x");
    expect(html).toContain("Could not be read");
    expect(html).toContain(">Remove<");
  });

  test("an open transcript renders speaker-attributed segments with timestamps", () => {
    const html = render({
      meetings: [meeting({ status: "completed" })],
      open: {
        id: "mtg_1",
        status: "ready",
        transcript: {
          meeting_id: "mtg_1",
          status: "completed",
          language: "en",
          duration_seconds: 125,
          speakers: [
            { id: "speaker_0", name: "Sam" },
            { id: "speaker_1", name: "Ada" },
          ],
          segments: [
            { id: "seg_1", speaker_id: "speaker_0", speaker_name: "Sam", start: 0, end: 3, text: "Let's begin." },
            { id: "seg_2", speaker_id: "speaker_1", speaker_name: "Ada", start: 65, end: 70, text: "Agreed." },
          ],
          text: "Sam: Let's begin.\nAda: Agreed.",
        },
      },
    });
    expect(html).toContain("2:05");
    expect(html).toContain("2 speakers");
    expect(html).toContain("Sam: ");
    expect(html).toContain("Let&#x27;s begin.");
    expect(html).toContain("1:05");
    expect(html).toContain("Ada: ");
    expect(html).toContain(">Hide<");
  });

  test("uncertain transcript windows are visible without claiming a speaker identity", () => {
    const html = render({ meetings: [meeting({ status: "completed" })], open: {
      id: "mtg_1", status: "ready", transcript: {
        meeting_id: "mtg_1", status: "completed", language: "en", duration_seconds: 4, speakers: [], text: "",
        segments: [
          { id: "a", speaker_id: "unknown", speaker_name: "Do not attribute", start: 0, end: 2, text: "Both voices.", attribution: "overlap" },
          { id: "b", speaker_id: "unknown", speaker_name: "Do not attribute", start: 2, end: 4, text: "Uncertain voice.", attribution: "unknown" },
        ],
      },
    } });
    expect(html).toContain("Overlapping speech");
    expect(html).toContain("Unknown speaker");
    expect(html).not.toContain("Do not attribute");
    expect(html).toContain("Both voices.");
    expect(html).toContain("Uncertain voice.");
  });

  test("save state is shown on the row", () => {
    expect(render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "saved" } })).toContain(
      "Saved to your space",
    );
    expect(render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "saving" } })).toContain(
      "Saving to your space",
    );
    expect(render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "error" } })).toContain(
      "Could not save to your space",
    );
    expect(render({ meetings: [meeting({ status: "completed" })] })).not.toContain("your space");
  });

  test("a pending transcript is told as still being prepared", () => {
    const html = render({
      meetings: [meeting({ status: "completed" })],
      open: { id: "mtg_1", status: "pending", meetingStatus: "processing" },
    });
    expect(html).toContain("still being prepared");
    expect(html).toContain("transcribing");
  });

  test("every status has a label", () => {
    const all: TranscriberMeetingStatus[] = [
      "queued",
      "joining",
      "waiting_for_admission",
      "in_progress",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ];
    for (const s of all) expect(statusLabel(s).length).toBeGreaterThan(0);
  });

  test("failures map to plain copy", () => {
    expect(describeFailure({ status: "rejected", httpStatus: 400, code: "invalid_meeting_url", message: null })).toContain(
      "meeting link",
    );
    expect(describeFailure({ status: "rejected", httpStatus: 400, code: "unsupported_platform", message: null })).toContain(
      "platform",
    );
    expect(describeFailure({ status: "retryable", httpStatus: 503, code: "transcriber_unavailable" })).toContain(
      "temporarily unavailable",
    );
    expect(describeFailure({ status: "feature-dark" })).toContain("configured");
  });
});

describe("TranscriberView local mode", () => {
  test("without a kind prop the card renders exactly the bot path (web)", () => {
    const html = render();
    expect(html).not.toContain("Meeting bot");
    expect(html).not.toContain("Local recording");
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain('id="transcriber-meeting-url"');
  });

  test("with kind props the segmented control renders and meeting-bot shows the bot form", () => {
    const html = render({
      kind: "meeting-bot",
      localPanel: <div data-testid="local-panel">local panel</div>,
      onKindChange: noop,
    });
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Meeting bot");
    expect(html).toContain("Local recording");
    expect(html).toContain('id="transcriber-meeting-url"');
    expect(html).not.toContain("local panel");
  });

  test("kind local renders the local panel instead of the bot form and list", () => {
    const html = render({
      kind: "local",
      localPanel: <div data-testid="local-panel">local panel</div>,
      onKindChange: noop,
      // even a dark/unreachable backend must not hide local capture
      listStatus: "dark",
    });
    expect(html).toContain('role="tablist"');
    expect(html).toContain("local panel");
    expect(html).not.toContain('id="transcriber-meeting-url"');
    expect(html).not.toContain("No meetings yet");
  });

  test("cannot switch away while a local recording workflow is active", () => {
    const html = render({
      kind: "local",
      localWorkflowActive: true,
      localPanel: <div>recording</div>,
      onKindChange: noop,
    });
    expect(html).toMatch(/role="tab"[^>]*disabled=""[^>]*>Meeting bot/);
    expect(html).toContain("recording");
  });
});

function renderLocal(patch: Partial<LocalTranscriberViewProps> = {}): string {
  const props: LocalTranscriberViewProps = {
    state: "ready",
    model: "QuantizedTinyEn",
    mics: { status: "loaded", devices: ["MacBook Mic"] },
    micDevice: "",
    downloadPct: null,
    statusText: null,
    onModelChange: noop,
    onMicChange: noop,
    onDownload: noop,
    onRetry: noop,
    onDiscardRecording: noop,
    onStart: noop,
    onStop: noop,
    ...patch,
  };
  return renderToStaticMarkup(<LocalTranscriberView {...props} />);
}

describe("LocalTranscriberView", () => {
  test("model sizes match anarlog's model files", () => {
    const html = renderLocal({ state: "needs-download" });
    expect(html).toContain("Download model (~44 MB)");
    expect(html).toContain("Whisper Base (English) · ~82 MB");
    expect(html).toContain("Whisper Small (multilingual) · ~264 MB");
    expect(html).toContain("Whisper Large Turbo · ~874 MB");
  });

  test("a failed microphone listing is an alert, distinct from an empty list", () => {
    const failed = renderLocal({ mics: { status: "failed", message: "list_microphone_devices: CoreAudio unavailable" } });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Couldn&#x27;t list microphones: list_microphone_devices: CoreAudio unavailable");
    expect(failed).not.toContain("No microphones were found");

    const empty = renderLocal({ mics: { status: "loaded", devices: [] } });
    expect(empty).toContain("No microphones were found on this Mac.");
    expect(empty).not.toContain('role="alert"');

    const loading = renderLocal({ mics: { status: "loading" } });
    expect(loading).not.toContain("No microphones were found");
    expect(loading).not.toContain("list microphones");
  });

  test("an unconfirmed stop offers Retry stop and keeps the capture locked", () => {
    const html = renderLocal({ state: "stop-failed", statusText: "Stopping was not confirmed: timed out." });
    expect(html).toContain(">Retry stop</button>");
    expect(html).toContain("Stopping was not confirmed");
    expect(html).toContain("Keep this view open while recording");
    expect(html).not.toContain("Start recording");
    expect(html).toMatch(/id="local-transcriber-model"[^>]*disabled=""/);
    expect(localRetryAction("stop-failed")).toBe("stop");
    expect(isLocalWorkflowActive("stop-failed")).toBe(true);
  });

  test("a failed transcription offers Retry transcription and Discard recording, and keeps the mode locked", () => {
    const html = renderLocal({
      state: "transcribe-failed",
      statusText: "Transcription failed (progressive_stream_timeout): no progress for 120s",
    });
    expect(html).toContain(">Retry transcription</button>");
    expect(html).toContain(">Discard recording</button>");
    expect(html).toContain("Transcription failed (progressive_stream_timeout)");
    expect(html).toContain("The recording is kept until it transcribes or you discard it.");
    expect(html).toContain("Discarding leaves its audio file on this Mac.");
    expect(html).not.toContain("Start recording");
    expect(html).not.toContain(">Retry</button>");
    expect(html).toMatch(/id="local-transcriber-model"[^>]*disabled=""/);
    expect(localRetryAction("transcribe-failed")).toBe("transcribe");
    expect(isLocalWorkflowActive("transcribe-failed")).toBe(true);
    const card = render({
      kind: "local",
      localWorkflowActive: isLocalWorkflowActive("transcribe-failed"),
      localPanel: <div>awaiting transcription</div>,
      onKindChange: noop,
    });
    expect(card).toMatch(/role="tab"[^>]*disabled=""[^>]*>Meeting bot/);
    // Discard belongs to the kept recording only.
    for (const state of ["stop-failed", "save-failed", "error"] as const) {
      expect(renderLocal({ state })).not.toContain("Discard recording");
    }
  });

  test("a partial recording offers Transcribe partial recording and Discard recording, with the capture warning", () => {
    const html = renderLocal({
      state: "partial-recording",
      statusText: "Capture failed: ActorFailed(mic stream closed). A partial recording was kept.",
    });
    expect(html).toContain(">Transcribe partial recording</button>");
    expect(html).toContain(">Discard recording</button>");
    expect(html).toContain("Capture failed: ActorFailed(mic stream closed)");
    expect(html).toContain("Capture stopped with an error, but the audio recorded until then was kept.");
    expect(html).not.toContain("Start recording");
    expect(html).not.toContain(">Retry transcription</button>");
    expect(localRetryAction("partial-recording")).toBe("transcribe");
    expect(isLocalWorkflowActive("partial-recording")).toBe(true);
  });

  test("a rejected start, stop or transcription retry lands in its own failed state", () => {
    expect(localFailureState(new CaptureStopUnconfirmedError("Stopping was not confirmed"))).toBe("stop-failed");
    expect(localFailureState(new TranscriptionFailedError("Transcription failed (x): y"))).toBe("transcribe-failed");
    expect(localFailureState(new PreviousCaptureUnconfirmedError("Native capture is active."))).toBe("previous-recording");
    expect(localFailureState(new PartialRecordingError("Capture failed: x. A partial recording was kept."))).toBe(
      "partial-recording",
    );
    expect(localFailureState(new Error("Capture failed: ActorFailed(mic stream closed)"))).toBe("error");
  });

  test("an unconfirmed previous recording is shown with why, and offers only Stop previous recording", () => {
    const message =
      "The Local recording view closed before its recording confirmed it stopped (Timed out waiting for native capture to confirm it stopped). Native capture is active. Stop it before starting a new recording.";
    const html = renderLocal({ state: "previous-recording", statusText: message });
    expect(html).toContain(">Stop previous recording</button>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("closed before its recording confirmed it stopped");
    expect(html).toContain("A new recording can&#x27;t start until the previous one is confirmed stopped.");
    expect(html).not.toContain("Start recording");
    expect(html).not.toContain(">Retry</button>");
    expect(html).toMatch(/id="local-transcriber-model"[^>]*disabled=""/);
    expect(localRetryAction("previous-recording")).toBe("stop-previous");
    expect(isLocalWorkflowActive("previous-recording")).toBe(true);

    const stopping = renderLocal({ state: "stopping-previous" });
    expect(stopping).toContain("Stopping previous recording…");
    expect(stopping).not.toContain("Start recording");
    expect(stopping).not.toContain(">Stop previous recording</button>");
    expect(isLocalWorkflowActive("stopping-previous")).toBe(true);
  });

  test("a failed save offers Retry save for the transcript it keeps", () => {
    const html = renderLocal({ state: "save-failed", statusText: "putTranscriptBody: [KV_UNAVAILABLE] kv write failed" });
    expect(html).toContain(">Retry save</button>");
    expect(html).toContain("The transcript is kept here until it saves.");
    expect(html).not.toContain("Start recording");
    expect(localRetryAction("save-failed")).toBe("save");
    expect(isLocalWorkflowActive("save-failed")).toBe(true);
  });

  test("an empty transcript is a visible error with the ordinary Retry", () => {
    const html = renderLocal({ state: "error", statusText: NO_SPEECH_MESSAGE });
    expect(html).toContain("No speech was transcribed — nothing was saved.");
    expect(html).toContain(">Retry</button>");
    expect(localRetryAction("error")).toBe("readiness");
    expect(isLocalWorkflowActive("error")).toBe(false);
  });
});

describe("transcriber client", () => {
  function session(token: string | null = "tok") {
    let t = token;
    return {
      getToken: () => t,
      isExpired: () => false,
      clear: () => {
        t = null;
      },
    } as unknown as import("@tinyboilerplate/client").SessionStore;
  }

  test("sends bearer + CSRF header and maps a list 404 to feature-dark", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    }) as typeof fetch;
    const client = createTranscriberClient("https://api.example", { sessionStore: session(), fetchImpl });
    expect(await client.list()).toEqual({ status: "feature-dark" });
    expect(seen[0]!.url).toBe("https://api.example/api/transcriber/meetings");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["X-Requested-With"]).toBe("XMLHttpRequest");
  });

  test("a per-meeting 404 is not-found, not feature-dark", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) as typeof fetch;
    const client = createTranscriberClient("https://api.example", { sessionStore: session(), fetchImpl });
    expect(await client.get("mtg_1")).toEqual({ status: "not-found" });
    expect(await client.remove("mtg_1")).toEqual({ status: "not-found" });
  });

  test("create posts JSON; a 400 comes back rejected with its code", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ error: "invalid_meeting_url" }), { status: 400 });
    }) as typeof fetch;
    const client = createTranscriberClient("https://api.example", { sessionStore: session(), fetchImpl });
    const r = await client.create({ meeting_url: "nope" });
    expect(r).toEqual({ status: "rejected", httpStatus: 400, code: "invalid_meeting_url", message: null });
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body as string)).toEqual({ meeting_url: "nope" });
  });

  test("transcript maps 202 to pending, 200+completed to ready, 200+failed to pending", async () => {
    let status = 202;
    let body: unknown = { meeting_id: "mtg_1", status: "processing" };
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    const client = createTranscriberClient("https://api.example", { sessionStore: session(), fetchImpl });
    expect(await client.transcript("mtg_1")).toEqual({
      status: "ok",
      value: { status: "pending", meetingStatus: "processing" },
    });
    status = 200;
    body = { meeting_id: "mtg_1", status: "completed", segments: [], text: "" };
    const ready = await client.transcript("mtg_1");
    expect(ready.status).toBe("ok");
    if (ready.status === "ok") expect(ready.value.status).toBe("ready");
    body = { meeting_id: "mtg_1", status: "failed" };
    expect(await client.transcript("mtg_1")).toEqual({
      status: "ok",
      value: { status: "pending", meetingStatus: "failed" },
    });
  });

  test("no token = unauthenticated without a network call; 401 clears the session", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("", { status: 401 });
    }) as typeof fetch;
    const noToken = createTranscriberClient("https://api.example", { sessionStore: session(null), fetchImpl });
    expect(await noToken.list()).toEqual({ status: "unauthenticated" });
    expect(calls).toBe(0);

    const s = session();
    const client = createTranscriberClient("https://api.example", { sessionStore: s, fetchImpl });
    expect(await client.list()).toEqual({ status: "unauthenticated" });
    expect(s.getToken()).toBeNull();
  });
});

describe("Connectors page wiring", () => {
  test("ConnectorsPage mounts TranscriberSection with the session, backend URL and the user's tcw", () => {
    const src = readFileSync(join(import.meta.dir, "ConnectorsPage.tsx"), "utf8");
    expect(src).toContain('import { TranscriberSection } from "./TranscriberSection";');
    expect(src).toMatch(
      /<TranscriberSection[\s\S]{0,180}backendUrl=\{backendUrl\}[\s\S]{0,180}sessionStore=\{sessionStore\}[\s\S]{0,180}tcw=\{tcw\}/,
    );
    // The section never touches connector secrets or a provider key: the backend proxy holds
    // the transcription key, and the user's space is written through the shared connector store.
    const section = readFileSync(join(import.meta.dir, "TranscriberSection.tsx"), "utf8");
    expect(section).not.toContain("connectorSecrets");
    expect(section).not.toContain("saveTranscriberMeeting");
    expect(section).toContain("useTranscriberSavedState");
    const shell = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");
    expect(shell.match(/<TranscriberLibrarySyncProvider /g)).toHaveLength(1);
    const sync = readFileSync(join(import.meta.dir, "useTranscriberLibrarySync.tsx"), "utf8");
    expect(sync).toContain("saveTranscriberMeeting");
  });
});


describe("recording departure diagnostics", () => {
  test("a salvaged transcript retains the browser crash rather than a silence explanation", () => {
    const html = render({ meetings: [meeting({ status: "completed", capture: { failure_reason: "browser_crashed", provider_status: "failed", exit_code: 1 } })] });
    expect(html).toContain("browser crashed");
    expect(html).toContain("browser_crashed");
    expect(html).not.toContain("audio-silence timeout");
    expect(html).not.toContain("reason was not reported");
    expect(html).toContain(">Transcript</button>");
  });
  test("a salvaged completed transcript still shows its early departure reason", () => {
    const html = render({ meetings: [meeting({ status: "completed", capture: { completion_reason: "left_alone", provider_status: "completed", audio_activity: "not_reported" }, transcript_provider: "tinfoil" })] });
    expect(html).toContain("audio-silence timeout");
    expect(html).toContain("audio capture stops");
    expect(html).toContain("Recording diagnostics");
    expect(html).toContain("mtg_1");
    expect(html).toContain("tinfoil");
    expect(html).toContain("Live audio health was not reported");
    expect(html).toContain(">Transcript</button>");
  });
  test("a runtime failure exposes the exit code while a legacy row admits missing evidence", () => {
    const failed = render({ meetings: [meeting({ status: "failed", capture: { provider_status: "failed", exit_code: 137 } })] });
    expect(failed).toContain("departure reason was not reported");
    expect(failed).toContain("137");
    const legacy = render({ meetings: [meeting({ status: "completed" })] });
    expect(legacy).toContain("Departure reason unavailable");
    expect(legacy).not.toContain("audio-silence timeout");
  });
  test("active meetings do not claim departure; removal and stop requests stay distinct", () => {
    expect(render({ meetings: [meeting({ status: "in_progress" })] })).not.toContain("Recording diagnostics");
    const html = render({ meetings: [meeting({ status: "completed", capture: { completion_reason: "evicted", stop_requested_by: "user" } })] });
    expect(html).toContain("removed or disconnected");
    expect(html).not.toContain("Bot was stopped.");
  });
});

describe("LocalTranscriberView: private cloud engine", () => {
  test("the engine picker appears only when private cloud is available", () => {
    const hidden = renderLocal();
    expect(hidden).not.toContain("Private cloud");
    expect(hidden).not.toContain('role="radiogroup"');
    const shown = renderLocal({ cloudAvailable: true });
    expect(shown).toContain('aria-label="Transcription engine"');
    expect(shown).toMatch(/role="radio" aria-checked="true"[^>]*>On this Mac/);
    expect(shown).toMatch(/role="radio" aria-checked="false"[^>]*>Private cloud/);
  });

  test("private cloud shows separate PTX and Tinfoil claims, no model picker, and asks once before the first use", () => {
    const html = renderLocal({ cloudAvailable: true, engine: "private-cloud" });
    expect(html).toContain("TinyCloud Private Transcription</strong>, a dedicated confidential virtual machine");
    expect(html).toContain("deletes the audio once transcription finishes or fails");
    expect(html).toContain("scheduled for deletion 24 hours after transcription");
    expect(html).toContain("anonymous account identifier, not your wallet address");
    expect(html).toContain("Tinfoil processes the segments inside hardware enclaves");
    expect(html).toContain('href="https://tinfoil.sh/security-and-privacy-faq"');
    expect(html).toContain('href="https://tinfoil.sh/privacy"');
    expect(html).toContain("It never receives your audio.");
    expect(html).toContain("The original recording stays on this Mac.");
    expect(html).not.toMatch(/verified|attested|end-to-end|no one can access|at most/i);
    expect(html).not.toContain("local-transcriber-model");
    expect(html).not.toContain("Download model");
    expect(html).toContain(">Use private cloud</button>");
    expect(html).not.toContain("Start recording");

    const consented = renderLocal({ cloudAvailable: true, engine: "private-cloud", cloudConsented: true });
    expect(consented).toContain("Start recording");
    expect(consented).not.toContain("Use private cloud");
  });

  test("an unavailable cloud choice is told, not silently switched", () => {
    const html = renderLocal({ cloudUnavailable: true });
    expect(html).toContain("Private cloud transcription isn&#x27;t available right now");
  });

  test("progress, failure reference and non-retryable failures", () => {
    expect(renderLocal({ state: "transcribing", engine: "private-cloud", progressText: "Uploading… 42%" })).toContain(
      "Uploading… 42%",
    );
    const failed = renderLocal({
      state: "transcribe-failed",
      engine: "private-cloud",
      statusText: "Private cloud transcription takes recordings up to 2 hours.",
      referenceId: "c0ffee",
      retryable: false,
      onDeviceOffer: true,
    });
    expect(failed).not.toContain(">Retry transcription</button>");
    expect(failed).toContain(">Transcribe on this Mac</button>");
    expect(failed).toContain(">Discard recording</button>");
    expect(failed).toContain("Reference: c0ffee");

    const lost = renderLocal({ state: "connection-lost", engine: "private-cloud", statusText: "Lost contact" });
    expect(lost).toContain(">Keep waiting</button>");
    expect(lost).toContain(">Discard recording</button>");
    expect(localFailureState(new CloudConnectionLostError("Lost contact"))).toBe("connection-lost");
    expect(localRetryAction("connection-lost")).toBe("transcribe");
    expect(isLocalWorkflowActive("connection-lost")).toBe(true);
  });

  test("the 1 h 50 min hint shows only while recording on private cloud", () => {
    expect(renderLocal({ state: "recording", engine: "private-cloud", nearCloudLimit: true })).toContain("up to 2 hours");
    expect(renderLocal({ state: "recording", nearCloudLimit: true })).not.toContain("up to 2 hours");
  });

  test("cloud progress text", () => {
    expect(cloudProgressText({ kind: "uploading", pct: 7 })).toBe("Uploading… 7%");
    expect(
      cloudProgressText({ kind: "cloud-processing", stage: "queued", queuePosition: 3, regionsCompleted: null, regionsTotal: null }),
    ).toBe("Queued (position 3)…");
    expect(
      cloudProgressText({ kind: "cloud-processing", stage: "processing", queuePosition: null, regionsCompleted: 4, regionsTotal: 10 }),
    ).toBe("Transcribing in private cloud… 4/10");
    expect(cloudProgressText({ kind: "transcribing", progress: 10 })).toBeNull();
  });
});
