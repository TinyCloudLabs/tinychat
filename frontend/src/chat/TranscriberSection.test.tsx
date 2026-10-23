// The meeting notetaker (Capture's Meeting sheet). `TranscriberView` is a pure function of its
// props, so every product rule is asserted against real markup via react-dom/server (same call as
// MeetingsSection.test.tsx: no DOM harness in this workspace). The client is asserted against
// an injected fetch. Rules:
//   1. dark (backend has no transcriber) says so and hides the form — never a blank card;
//   2. an outage/offline/signed-out list is TOLD, never rendered as "no meetings";
//   3. active meetings can end and transcribe now, completed ones show Transcript, terminal ones show Remove;
//   4. a transcript renders speaker-attributed segments;
//   5. the client sends bearer + CSRF header, maps 202 to pending and list-404 to feature-dark;
//   6. Capture owns the one useMeetingBot and hands it to the Meeting sheet and the In progress rows.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import {
  TranscriberView,
  clearSendIntentKey,
  clearSendIntentsForOwner,
  describeFailure,
  getOrCreateSendIntent,
  meetingTitle,
  normalizeMeetingUrl,
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
  return renderToStaticMarkup(
    <MemoryRouter>
      <TranscriberView {...props} />
    </MemoryRouter>,
  );
}

describe("TranscriberView", () => {
  test("an ambiguous send stays disabled while checking and while the normalized URL has an active bot", () => {
    const checking = render({ form: { url: "https://meet.jit.si/room", botName: "", submitting: false,
      checking: true, error: null } });
    expect(checking).toContain("Checking whether the notetaker joined…");
    expect(checking).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send notetaker to meeting"/);
    expect(checking).not.toMatch(/id="transcriber-meeting-url"[^>]*disabled=""/);
    const active = render({ form: { url: "https://meet.jit.si/room", botName: "", submitting: false,
      active: true, error: null } });
    expect(active).toContain("already joining this meeting");
    expect(active).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Send notetaker to meeting"/);
  });

  test("a failed send reloads its stable key and request fields, then an explicit clear replaces it", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const url = "https://meet.jit.si/room";
    const first = getOrCreateSendIntent(url, { meeting_url: `${url}#capability`, bot_name: "First" }, undefined, storage);
    const reloaded = getOrCreateSendIntent(url, { meeting_url: url, bot_name: "Edited" }, undefined, storage);
    expect(reloaded).toEqual(first);
    expect(getOrCreateSendIntent("https://meet.jit.si/other", { meeting_url: "https://meet.jit.si/other" }, undefined, storage).key)
      .not.toBe(first.key);
    clearSendIntentKey(url, storage);
    expect(getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage).key).not.toBe(first.key);
  });

  test("send intent storage failures fall back to a usable in-memory intent", () => {
    const storage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    const intent = getOrCreateSendIntent("https://meet.jit.si/room", { meeting_url: "https://meet.jit.si/room" }, undefined, storage);
    const retry = getOrCreateSendIntent("https://meet.jit.si/room", { meeting_url: "https://meet.jit.si/room" }, undefined, storage);
    expect(intent.key).toMatch(/^manual-v1-[0-9a-f-]{36}$/);
    expect(retry.key).toBe(intent.key);
    expect(() => clearSendIntentKey("https://meet.jit.si/room", storage)).not.toThrow();
  });

  test("a tampered stored send intent is replaced instead of replayed as a bad key", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const url = "https://meet.jit.si/tampered";
    const owner = "0xtamper";
    const minted = getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, owner);
    const storageKey = [...values.keys()][0]!;
    for (const tampered of ['{"key":"not-a-send-key","input":{"meeting_url":"https://meet.jit.si/tampered"}}',
      '{"key":"manual-v1-11111111-1111-4111-8111-111111111111","input":{"meeting_url":""}}',
      "manual-v1-11111111-1111-4111-8111-111111111111", "{not json"]) {
      // Only storage holds the tampered row: a live component would have no memory entry either.
      clearSendIntentKey(url, storage, owner);
      values.set(storageKey, tampered);
      const replacement = getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, owner);
      expect(replacement.key).toMatch(/^manual-v1-[0-9a-f-]{36}$/);
      expect(replacement.key).not.toBe(minted.key);
      expect(replacement.input.meeting_url).toBe(url);
      expect(JSON.parse(values.get(storageKey)!)).toMatchObject({ key: replacement.key });
    }
  });

  test("send intents are account-scoped and sign-out clears only that account", () => {
    const values = new Map<string, string>();
    const storage = {
      get length() { return values.size; },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    } as Storage;
    const url = "https://meet.jit.si/account-room";
    const a = getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, "0xAAA");
    const b = getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, "0xBBB");
    expect(a.key).not.toBe(b.key);
    clearSendIntentsForOwner("0xAAA", storage);
    expect(getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, "0xAAA").key).not.toBe(a.key);
    expect(getOrCreateSendIntent(url, { meeting_url: url }, undefined, storage, "0xBBB").key).toBe(b.key);
  });

  test("TC-988: not_accepted shows the invite acceptance copy in calendar outcomes", () => {
    const html = render({ calendarOutcomes: [{ id: "unaccepted", title: "Calendar invite", start: 1_800_000_000_000,
      reason: "not_accepted" }] });
    expect(html).toContain("Calendar autojoin outcomes");
    expect(html).toContain("Accept the invite to have the notetaker join");
  });

  test("TC-988: declined and frozen ineligible outcomes do not ask the user to accept", () => {
    const html = render({ calendarOutcomes: [{ id: "declined", title: "Declined invite", start: 1_800_000_000_000,
      reason: "event_ineligible" }] });
    expect(html).toContain("The event no longer meets the attendance or meeting requirements for autojoin.");
    expect(html).not.toContain("Accept the invite to have the notetaker join");
  });

  test("dark says the backend is not configured and hides the form", () => {
    const html = render({ listStatus: "dark" });
    expect(html).toContain('data-testid="meeting-bot"');
    expect(html).toContain("isn&#x27;t configured");
    expect(html).toContain("TRANSCRIPTION_API_URL");
    expect(html).not.toContain("transcriber-meeting-url");
  });

  test("ready + empty shows the form and an empty-state hint", () => {
    const html = render();
    expect(html).toContain('id="transcriber-meeting-url"');
    expect(html).toContain("Send notetaker");
    // Visible labels, and 16 px fields on touch (no iOS zoom on focus).
    expect(html).toContain(">Meeting link</label>");
    expect(html).toContain(">Notetaker name (optional)</label>");
    expect(html).toMatch(/id="transcriber-meeting-url"[^>]*class="[^"]*\btext-body\b[^"]*fine:text-sm/);
    // The route, one line, and How it works for the rest; the five-minute rule is a one-line hint.
    expect(html).toContain('aria-label="Where your audio goes"');
    expect(html).toContain("Meeting</span>");
    expect(html).toContain("TinyCloud notetaker");
    expect(html).toContain("shows up in Library");
    expect(html).toContain('href="/chat/about#notetaker"');
    expect(html).toContain('aria-label="About notetaker sessions"');
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
    expect(active).toContain('aria-label="End meeting and transcribe now"');
    expect(active).toContain("<span>End</span>");
    expect(active).not.toContain(">Remove<");
    expect(active).not.toContain(">Transcript<");

    const processing = render({ meetings: [meeting({ status: "processing" })] });
    expect(processing).toContain("Transcribing");
    expect(processing).not.toContain("End meeting and transcribe now");

    const done = render({ meetings: [meeting({ status: "completed" })] });
    expect(done).toContain(">Transcript<");
    expect(done).toContain(">Remove<");
    expect(done).not.toContain("End meeting and transcribe now");

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

  test("a stuck-joining notetaker is still active, labelled, and ends the same way as a joining one", () => {
    const stuck = render({ meetings: [meeting({ status: "needs_help" })] });
    expect(stuck).toContain("Stuck joining");
    expect(stuck).toContain('aria-label="End meeting and transcribe now"');
    expect(stuck).not.toContain(">Remove<");
    expect(stuck).not.toContain(">Transcript<");
  });

  test("TC-581: a recording shared from another account says so and only removes it from this list", () => {
    const shared = render({ meetings: [meeting({ status: "completed", metadata: { source: "google-calendar-autojoin",
      calendar_title: "Team sync", scheduled_start: "2026-09-25T12:00:00.000Z", shared: true } })] });
    expect(shared).toContain("Shared recording");
    expect(shared).toContain(">Remove from my list<");
    expect(shared).toContain(">Transcript<");
    expect(shared).toContain("Team sync");
    const own = render({ meetings: [meeting({ status: "completed" })] });
    expect(own).not.toContain("Shared recording");
    expect(own).toContain(">Remove<");
    expect(own).not.toContain("Remove from my list");
  });

  test("ending a meeting shows immediate finalization feedback", () => {
    const html = render({
      meetings: [meeting({ status: "in_progress" })],
      busyId: "mtg_1",
    });
    expect(html).toContain("Ending…");
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

  test("null and legacy Unknown speakers render without labels or dangling separators", () => {
    const html = render({ meetings: [meeting({ status: "completed" })], open: {
      id: "mtg_1", status: "ready", transcript: {
        meeting_id: "mtg_1", status: "completed", speakers: [],
        segments: [
          { id: "a", speaker_id: "unknown", speaker_name: null, start: 0, end: 1, text: "No speaker field." },
          { id: "b", speaker_id: "unknown", speaker_name: null, attribution: "unknown", start: 1, end: 2, text: "Unattributed by ptx." },
          { id: "c", speaker_id: "unknown", speaker_name: "Unknown", start: 2, end: 3, text: "Legacy placeholder." },
          { id: "d", speaker_id: "unknown", speaker_name: "  Unknown  ", start: 3, end: 4, text: "Padded placeholder." },
        ],
      },
    } });
    expect(html).not.toContain('class="font-medium"');
    expect(html).not.toContain("Unknown");
    expect(html).not.toContain(": </span>");
    for (const text of ["No speaker field.", "Unattributed by ptx.", "Legacy placeholder.", "Padded placeholder."]) {
      expect(html).toContain(text);
    }
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

  test("save state keeps separators readable and renders failures in destructive text", () => {
    expect(render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "saved" } })).toContain(
      "Saved to your space",
    );
    expect(render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "saving" } })).toContain(
      "Saving to your space",
    );
    const failed = render({ meetings: [meeting({ status: "completed" })], saved: { mtg_1: "error" } });
    expect(failed).toMatch(/Completed · .+ · TinyCloud Private Notetaker/);
    expect(failed).toMatch(/data-testid="meeting-save-error" class="[^"]*text-\[var\(--red-text\)\][^"]*">Could not save to your space</);
    expect(failed).not.toMatch(/>\s*·/);
    const unsaved = render({ meetings: [meeting({ status: "completed" })] });
    expect(unsaved.slice(unsaved.indexOf('id="transcriber-sessions"'))).not.toContain("your space");
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
      "needs_help",
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

  test("TC-907: a capacity refusal shows ptx's busy message, not the generic outage copy", () => {
    const message = "All 2 meeting notetakers are busy right now. Try again when one of the current meetings ends.";
    expect(describeFailure({ status: "retryable", httpStatus: 429, code: "capacity_exhausted", message })).toBe(message);
    expect(describeFailure({ status: "retryable", httpStatus: 429, code: "capacity_exhausted" })).toContain("notetakers are busy");
    expect(describeFailure({ status: "retryable", httpStatus: 429, code: "upstream_rate_limited" })).toContain("temporarily unavailable");
  });
});

describe("pasted meeting links", () => {
  test("loosely pasted forms of one Meet link share the dedupe key of the link ptx joins", () => {
    const key = normalizeMeetingUrl("https://meet.google.com/ofj-ahew-paa");
    expect(key).toBe("https://meet.google.com/ofj-ahew-paa");
    for (const pasted of ["https://google.com/meet/ofj-ahew-paa", "meet.google.com/ofj-ahew-paa", "ofj-ahew-paa", "Join: meet.google.com/ofj-ahew-paa"]) {
      expect(normalizeMeetingUrl(pasted)).toBe(key);
    }
    expect(normalizeMeetingUrl("not a meeting link")).toBeNull();
  });
});

describe("TranscriberView in the Meeting sheet", () => {
  test("the view is only the notetaker: no source tabs and no upload or local panels (they have their own places)", () => {
    const html = render();
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("Meeting bot");
    expect(html).not.toContain("Local recording");
    expect(html).not.toContain("Upload audio");
    expect(html).toContain('id="transcriber-meeting-url"');
    const source = readFileSync(join(import.meta.dir, "TranscriberSection.tsx"), "utf8");
    expect(source).not.toContain("uploadPanel");
    expect(source).not.toContain("localPanel");
    expect(source).not.toContain("onKindChange");
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

describe("Capture wiring", () => {
  test("CaptureSurface calls useMeetingBot once and passes it to the Meeting sheet and the In progress rows", () => {
    const src = readFileSync(join(import.meta.dir, "../capture/CaptureSurface.tsx"), "utf8");
    expect(src.match(/useMeetingBot\(/g)).toHaveLength(1);
    expect(src).toContain("const bot = useMeetingBot({ backendUrl, sessionStore, active: homeShown });");
    expect(src).toContain("<MeetingSheet open={sheet === \"meeting\"} onOpenChange={sheetChange(\"meeting\")} bot={bot} />");
    // The In progress rows' props (SoftCaptureHome renders them).
    expect(src).toContain("meetings: activeMeetings(bot.meetings),");
    expect(src).toContain("onEnd: bot.actions.stop,");
    expect(src).toContain("inProgress={inProgress}");
    // The Meeting action is hidden when the backend has no notetaker.
    expect(src).toContain('bot.listStatus === "dark" ? {} : { onMeeting: () => setSheet("meeting") }');
    // The notetaker never touches connector secrets or a provider key: the backend proxy holds
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
