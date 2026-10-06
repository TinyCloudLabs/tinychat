// useMeetingBot, mounted (TC-761): the notetaker's list read never overlaps
// itself (the next poll is scheduled only after the last read settled), and a
// read still out when Capture leaves the screen, or unmounts, is dropped.
//
// There is no DOM in this workspace. A tree that renders nothing needs very
// little of one, so react-dom/client mounts the hook on a stub container, and
// `window` is a stand-in whose setTimeout and clearTimeout are a clock the
// test moves by hand (the hook schedules through window.*; React's own
// scheduler keeps the real timers).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SessionStore } from "@tinyboilerplate/client";

import { useMeetingBot, type MeetingBot } from "@/chat/TranscriberSection";
import type { TranscriberClient, TranscriberListRow, TranscriberMeeting, TranscriberResult } from "@/lib/transcriberApi";

type ListResult = TranscriberResult<{ meetings: TranscriberListRow[] }>;

/** Timers the test fires by hand, in order. */
function manualClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    setTimeout: (run: () => void, ms = 0) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, run });
      return nextId;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    pending: () => timers.size,
    /** Moves time on, firing each timer that falls due (and letting what it starts settle). */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        await act(async () => {
          due[1].run();
        });
      }
      now = end;
    },
  };
}

const clock = manualClock();
const saved = { window: (globalThis as { window?: unknown }).window, act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as { window?: unknown }).window = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    // What react-dom reads of `window` for a tree with no host nodes.
    event: undefined,
    HTMLIFrameElement: class {},
  };
});

afterAll(() => {
  (globalThis as { window?: unknown }).window = saved.window;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
});

const live: TranscriberMeeting = {
  id: "mtg_live",
  status: "in_progress",
  platform: "google_meet",
  meeting_url: "https://meet.google.com/abc-defg-hij",
  created_at: "2026-10-06T09:30:00.000Z",
};
const ok = (meetings: TranscriberListRow[]): ListResult => ({ status: "ok", value: { meetings } });

/** A client whose list reads stay out until the test answers them. */
function slowClient() {
  const reads: Array<(result: ListResult) => void> = [];
  const client = { list: () => new Promise<ListResult>((resolve) => reads.push(resolve)) } as unknown as TranscriberClient;
  return { client, reads };
}

function calendarStub() {
  const stub = {
    calls: 0,
    status: async () => {
      stub.calls += 1;
      return { outcomes: [] };
    },
  };
  return stub;
}

function Probe(props: { active: boolean; client: TranscriberClient; calendar: ReturnType<typeof calendarStub>; seen: MeetingBot[] }) {
  const bot = useMeetingBot({
    backendUrl: "http://127.0.0.1",
    sessionStore: {} as SessionStore,
    client: props.client,
    calendar: props.calendar as never,
    active: props.active,
  });
  props.seen.push(bot);
  return null;
}

const container = {
  nodeType: 1,
  nodeName: "DIV",
  tagName: "DIV",
  ownerDocument: null,
  textContent: "",
  addEventListener() {},
  removeEventListener() {},
} as unknown as HTMLElement;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

async function mount(props: Parameters<typeof Probe>[0]) {
  root = createRoot(container);
  await act(async () => root!.render(<Probe {...props} />));
  // The calendar's first refresh lands.
  await act(async () => {});
}

describe("useMeetingBot, mounted", () => {
  test("a slow list read never overlaps the next poll; the next one is scheduled after it settles", async () => {
    const { client, reads } = slowClient();
    const calendar = calendarStub();
    const seen: MeetingBot[] = [];
    await mount({ active: true, client, calendar, seen });
    expect(reads).toHaveLength(1);

    await act(async () => reads[0]!(ok([live])));
    expect(seen.at(-1)!.meetings).toEqual([live]);

    // A meeting is moving, so the poll is armed: 5 s on, the second read goes out.
    await clock.advance(5_000);
    expect(reads).toHaveLength(2);
    // It is slow. Three more intervals pass, and nothing overlaps it.
    await clock.advance(15_000);
    expect(reads).toHaveLength(2);

    // Once it settles, the next one is 5 s away.
    await act(async () => reads[1]!(ok([live])));
    await clock.advance(4_999);
    expect(reads).toHaveLength(2);
    await clock.advance(1);
    expect(reads).toHaveLength(3);
  });

  test("leaving the screen drops the read still out and stops every timer", async () => {
    const { client, reads } = slowClient();
    const calendar = calendarStub();
    const seen: MeetingBot[] = [];
    await mount({ active: true, client, calendar, seen });
    await act(async () => reads[0]!(ok([live])));
    await clock.advance(5_000);
    expect(reads).toHaveLength(2);
    expect(calendar.calls).toBe(1);

    await act(async () => root!.render(<Probe active={false} client={client} calendar={calendar} seen={seen} />));
    const rendersAfterLeaving = seen.length;
    // The read that was out lands with a different list: no state update.
    await act(async () => reads[1]!(ok([])));
    expect(seen.length).toBe(rendersAfterLeaving);
    expect(seen.at(-1)!.meetings).toEqual([live]);
    expect(seen.at(-1)!.listStatus).toBe("ready");

    // Off screen, nothing reads: no poll, no calendar refresh, no timer left.
    expect(clock.pending()).toBe(0);
    await clock.advance(120_000);
    expect(reads).toHaveLength(2);
    expect(calendar.calls).toBe(1);

    // Back on screen: one fresh read (the dropped one doesn't block it).
    await act(async () => root!.render(<Probe active client={client} calendar={calendar} seen={seen} />));
    expect(reads).toHaveLength(3);
    await act(async () => reads[2]!(ok([])));
    expect(seen.at(-1)!.meetings).toEqual([]);
  });

  test("unmounting drops the read still out and leaves no timer", async () => {
    const { client, reads } = slowClient();
    const calendar = calendarStub();
    const seen: MeetingBot[] = [];
    await mount({ active: true, client, calendar, seen });
    await act(async () => reads[0]!(ok([live])));
    await clock.advance(5_000);
    expect(reads).toHaveLength(2);

    await act(async () => root!.unmount());
    root = null;
    const renders = seen.length;
    await act(async () => reads[1]!(ok([])));
    expect(seen.length).toBe(renders);
    expect(clock.pending()).toBe(0);
  });
});
