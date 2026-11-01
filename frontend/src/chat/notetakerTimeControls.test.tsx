// Exo Notetaker time controls (TC-2243, PTX #137). Rules:
//   1. the form offers a duration, defaulting to one hour, and Send notetaker sends it as
//      `max_duration_seconds`;
//   2. a live notetaker offers +15 min, +30 min and No limit; at the 4-hour cap there is nothing
//      left to extend, and a finished or shared one is never extendable;
//   3. the extension actions call the PTX #137 PATCH through the transcriber client;
//   4. the server-provided `scheduled_stop_at` shows as "Stops at …".
// Markup is asserted through react-dom/server (no DOM harness here); the hook is mounted on a stub
// container like useMeetingBot.test.tsx.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";

import { TranscriberView, MeetingTimeControls, useMeetingBot, type MeetingBot, type TranscriberViewProps } from "./TranscriberSection";
import {
  DEFAULT_NOTETAKER_DURATION_SECONDS,
  NOTETAKER_DURATION_OPTIONS,
  extensionsFor,
  formatStopsAt,
} from "@/lib/notetakerDuration";
import {
  createTranscriberClient,
  type TranscriberClient,
  type TranscriberMeeting,
  type TranscriberResult,
} from "@/lib/transcriberApi";

const HOUR = 3600;
const noop = () => {};

interface ControlProps { "data-extension"?: string; children?: ReactNode; disabled?: boolean; onClick?: () => void }

/** The extension controls inside a rendered element tree: the elements a user clicks. */
function buttonsOf(node: ReactNode): ReactElement<ControlProps>[] {
  if (Array.isArray(node)) return node.flatMap(buttonsOf);
  if (!isValidElement<ControlProps>(node)) return [];
  return node.props["data-extension"] !== undefined ? [node] : buttonsOf(node.props.children);
}

function meeting(patch: Partial<TranscriberMeeting> = {}): TranscriberMeeting {
  return {
    id: "mtg_live",
    status: "in_progress",
    platform: "google_meet",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    created_at: "2026-10-06T09:30:00.000Z",
    max_duration_seconds: HOUR,
    scheduled_stop_at: "2026-10-06T10:30:00.000Z",
    ...patch,
  };
}

function render(patch: Partial<TranscriberViewProps> = {}): string {
  const props: TranscriberViewProps = {
    listStatus: "ready",
    meetings: [],
    saved: {},
    form: { url: "", botName: "", durationSeconds: DEFAULT_NOTETAKER_DURATION_SECONDS, submitting: false, error: null },
    busyId: null,
    open: null,
    onUrlChange: noop,
    onBotNameChange: noop,
    onDurationChange: noop,
    onSubmit: noop,
    onRefresh: noop,
    onStop: noop,
    onExtend: noop,
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

describe("duration selection", () => {
  test("defaults to one hour and offers choices up to the four-hour maximum", () => {
    expect(DEFAULT_NOTETAKER_DURATION_SECONDS).toBe(HOUR);
    const seconds = NOTETAKER_DURATION_OPTIONS.map((o) => o.seconds);
    expect(seconds).toContain(HOUR);
    expect(Math.max(...seconds)).toBe(4 * HOUR);

    const html = render();
    expect(html).toContain("Stop after");
    expect(html).toMatch(/<option value="3600" selected="">1 hour<\/option>/);
    expect(html).toContain('<option value="14400">4 hours (maximum)</option>');
  });

  test("the selected duration is the one rendered as selected", () => {
    const html = render({ form: { url: "", botName: "", durationSeconds: 7200, submitting: false, error: null } });
    expect(html).toMatch(/<option value="7200" selected="">2 hours<\/option>/);
    expect(html).not.toMatch(/<option value="3600" selected/);
  });
});

describe("extension options and cap", () => {
  test("a live notetaker offers +15 min, +30 min and No limit", () => {
    const html = render({ meetings: [meeting()] });
    expect(html).toContain("+15 min");
    expect(html).toContain("+30 min");
    expect(html).toContain("No limit");
    expect(extensionsFor(meeting()).map((e) => e.id)).toEqual(["plus15", "plus30", "no-limit"]);
  });

  test("at the four-hour cap there is nothing to extend", () => {
    const capped = meeting({ max_duration_seconds: 4 * HOUR });
    expect(extensionsFor(capped)).toEqual([]);
    const html = render({ meetings: [capped] });
    expect(html).not.toContain("+15 min");
    expect(html).not.toContain("No limit");
  });

  test("not offered once processing, finished, shared, or when the server reports no duration", () => {
    for (const status of ["processing", "completed", "failed", "cancelled"] as const) {
      expect(extensionsFor(meeting({ status }))).toEqual([]);
    }
    expect(extensionsFor(meeting({ metadata: { shared: true } }))).toEqual([]);
    expect(extensionsFor(meeting({ max_duration_seconds: undefined }))).toEqual([]);
    // Queued/joining bots are live too.
    expect(extensionsFor(meeting({ status: "joining" })).length).toBe(3);
  });

  test("each control calls onExtend with its own extension for this meeting", () => {
    const picked: Array<[string, string]> = [];
    const view = MeetingTimeControls({ meeting: meeting(), live: true, busy: false, onExtend: (id, ext) => picked.push([id, ext]) });
    const controls = buttonsOf(view);
    expect(controls.map((c) => [c.props.children, c.props["data-extension"]])).toEqual([
      ["+15 min", "plus15"],
      ["+30 min", "plus30"],
      ["No limit", "no-limit"],
    ]);
    for (const control of controls) control.props.onClick?.();
    expect(picked).toEqual([["mtg_live", "plus15"], ["mtg_live", "plus30"], ["mtg_live", "no-limit"]]);
  });

  test("while an action is in flight the controls are disabled", () => {
    const view = MeetingTimeControls({ meeting: meeting(), live: true, busy: true, onExtend: noop });
    expect(buttonsOf(view).every((c) => c.props.disabled === true)).toBe(true);
  });
});

describe("stop time display", () => {
  // Fixed zone so the clock reads the same everywhere; the default locale is what a user of this build sees.
  const savedTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = "UTC"; });
  afterAll(() => { if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz; });
  const now = new Date("2026-10-06T09:45:00.000Z");

  test("a stop later today reads as the clock time only", () => {
    const text = formatStopsAt("2026-10-06T10:30:00.000Z", now);
    expect(text).toMatch(/^Stops at 10:30\b/);
    expect(text).not.toMatch(/Oct|\b6\b/);
  });

  test("a stop on another day names the day as well", () => {
    expect(formatStopsAt("2026-10-08T10:30:00.000Z", now)).toMatch(/^Stops at \D*\b8\b\D+10:30\b/);
  });

  test("missing or unparseable stop time shows nothing", () => {
    expect(formatStopsAt(null, now)).toBeNull();
    expect(formatStopsAt(undefined, now)).toBeNull();
    expect(formatStopsAt("soon", now)).toBeNull();
  });

  test("a live row shows the server's stop time; a finished one does not", () => {
    expect(render({ meetings: [meeting()] })).toContain("Stops at ");
    expect(render({ meetings: [meeting({ status: "completed" })] })).not.toContain("Stops at ");
  });
});

describe("transcriber client PATCH (PTX #137)", () => {
  function recorder(response: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return response.clone();
    }) as unknown as typeof fetch;
    const sessionStore = { getToken: () => "tok", isExpired: () => false } as unknown as SessionStore;
    return { calls, client: createTranscriberClient("http://b", { sessionStore, fetchImpl }) };
  }

  test("+15 and +30 send extend_by_seconds; No limit sends null max_duration_seconds", async () => {
    const body = JSON.stringify(meeting());
    const r = recorder(new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    await r.client.extend("mtg_live", { extend_by_seconds: 900 });
    await r.client.extend("mtg_live", { extend_by_seconds: 1800 });
    await r.client.extend("mtg_live", { max_duration_seconds: null });
    expect(r.calls.map((c) => [c.init.method, c.url, c.init.body])).toEqual([
      ["PATCH", "http://b/api/transcriber/meetings/mtg_live", '{"extend_by_seconds":900}'],
      ["PATCH", "http://b/api/transcriber/meetings/mtg_live", '{"extend_by_seconds":1800}'],
      ["PATCH", "http://b/api/transcriber/meetings/mtg_live", '{"max_duration_seconds":null}'],
    ]);
  });

  test("create carries max_duration_seconds", async () => {
    const r = recorder(new Response(JSON.stringify(meeting()), { status: 201, headers: { "content-type": "application/json" } }));
    await r.client.create({ meeting_url: "https://meet.google.com/abc-defg-hij", max_duration_seconds: 7200 });
    expect(JSON.parse(String(r.calls[0]!.init.body))).toEqual({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      max_duration_seconds: 7200,
    });
  });
});

// --- hook, mounted -------------------------------------------------------------------------
const saved = {
  window: (globalThis as { window?: unknown }).window,
  act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
};
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: noop,
    event: undefined,
    HTMLIFrameElement: class {},
  };
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const container = {
  nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
  addEventListener() {}, removeEventListener() {},
} as unknown as HTMLElement;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

function fakeClient(initial: TranscriberMeeting) {
  // Stateful like the server: a re-read after the extension returns the extended meeting.
  let live = initial;
  const created: unknown[] = [];
  const extended: unknown[] = [];
  const client: Pick<TranscriberClient, "list" | "create" | "extend"> = {
    list: async () => ({ status: "ok", value: { meetings: [live] } }),
    create: async (input) => {
      created.push(input);
      return { status: "ok", value: meeting({ id: "mtg_new", status: "queued" }) };
    },
    extend: async (_id, update): Promise<TranscriberResult<TranscriberMeeting>> => {
      extended.push(update);
      live = { ...live, max_duration_seconds: 5400, scheduled_stop_at: "2026-10-06T11:00:00.000Z" };
      return { status: "ok", value: live };
    },
  };
  return { client: client as TranscriberClient, created, extended };
}

async function mountBot(client: TranscriberClient, seen: MeetingBot[]) {
  // Stable across renders: a fresh calendar object each render would re-run the refresh effect forever.
  const sessionStore = {} as SessionStore;
  const calendar = { status: async () => ({ outcomes: [] }) } as never;
  function Probe() {
    const bot = useMeetingBot({
      backendUrl: "http://127.0.0.1",
      sessionStore,
      client,
      calendar,
      active: true,
    });
    seen.push(bot);
    return null;
  }
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  await act(async () => {});
}

describe("useMeetingBot time controls, mounted", () => {
  test("Send notetaker sends the one-hour default, then the chosen duration", async () => {
    const f = fakeClient(meeting({ status: "completed" }));
    const seen: MeetingBot[] = [];
    await mountBot(f.client, seen);
    expect(seen.at(-1)!.form.durationSeconds).toBe(HOUR);

    await act(async () => seen.at(-1)!.actions.setUrl("https://meet.jit.si/default-room"));
    await act(async () => seen.at(-1)!.actions.submit());
    await act(async () => {});
    expect(f.created[0]).toMatchObject({ meeting_url: "https://meet.jit.si/default-room", max_duration_seconds: HOUR });

    await act(async () => seen.at(-1)!.actions.setDuration(2 * HOUR));
    await act(async () => seen.at(-1)!.actions.setUrl("https://meet.jit.si/two-hours"));
    await act(async () => seen.at(-1)!.actions.submit());
    await act(async () => {});
    expect(f.created[1]).toMatchObject({ meeting_url: "https://meet.jit.si/two-hours", max_duration_seconds: 2 * HOUR });
  });

  test("extending a live notetaker updates its stop time from the server response", async () => {
    const f = fakeClient(meeting());
    const seen: MeetingBot[] = [];
    await mountBot(f.client, seen);
    await act(async () => seen.at(-1)!.actions.extend("mtg_live", "plus30"));
    await act(async () => {});
    expect(f.extended).toEqual([{ extend_by_seconds: 1800 }]);
    const row = seen.at(-1)!.meetings.find((m) => m.id === "mtg_live") as TranscriberMeeting;
    expect(row.scheduled_stop_at).toBe("2026-10-06T11:00:00.000Z");
    expect(row.max_duration_seconds).toBe(5400);

    await act(async () => seen.at(-1)!.actions.extend("mtg_live", "no-limit"));
    await act(async () => {});
    expect(f.extended[1]).toEqual({ max_duration_seconds: null });
  });
});
