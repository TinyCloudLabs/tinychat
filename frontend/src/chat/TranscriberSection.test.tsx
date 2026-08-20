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

describe("Settings wiring", () => {
  test("SettingsPage mounts TranscriberSection with the session, backend URL and the user's tcw", () => {
    const src = readFileSync(join(import.meta.dir, "SettingsPage.tsx"), "utf8");
    expect(src).toContain('import { TranscriberSection } from "./TranscriberSection";');
    expect(src).toMatch(
      /<TranscriberSection backendUrl=\{backendUrl\} sessionStore=\{sessionStore\} tcw=\{tcw\} \/>/,
    );
    // The section never touches connector secrets or a provider key: the backend proxy holds
    // the transcription key, and the user's space is written through the shared connector store.
    const section = readFileSync(join(import.meta.dir, "TranscriberSection.tsx"), "utf8");
    expect(section).not.toContain("connectorSecrets");
    expect(section).toContain("saveTranscriberMeeting");
  });
});
