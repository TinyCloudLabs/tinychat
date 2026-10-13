import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TranscriberClient, TranscriberMeeting } from "@/lib/transcriberApi";
import { SendNotetakerButton, useMeetingBot, type MeetingBot } from "./TranscriberSection";

let cleanupDom: (() => void) | undefined;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  cleanupDom?.();
  cleanupDom = undefined;
});

const activeMeeting = (url: string): TranscriberMeeting => ({
  id: "mtg_active",
  status: "joining",
  platform: "jitsi",
  meeting_url: url,
  created_at: "2026-10-13T12:00:00.000Z",
});

describe("TC-1016 send recovery", () => {
  test("an ambiguous create checks the list and never re-enables Send when the bot is active", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    type ListResult = Awaited<ReturnType<TranscriberClient["list"]>>;
    let releaseList!: (value: ListResult) => void;
    const listResult = new Promise<ListResult>(resolve => { releaseList = resolve; });
    const creates: Array<{ url: string; key: string | undefined }> = [];
    const client: TranscriberClient = {
      list: () => listResult,
      create: async (input, options) => {
        creates.push({ url: input.meeting_url, key: options?.idempotencyKey });
        return { status: "offline" };
      },
      get: async () => ({ status: "not-found" }),
      stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }),
      remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() {
      bot = useMeetingBot({
        backendUrl: "https://backend.example",
        sessionStore: { getToken: () => "token", isExpired: () => false } as SessionStore,
        client,
        calendar: { status: async () => ({ enabled: false, outcomes: [] }) },
        active: false,
      });
      return <SendNotetakerButton form={bot.form} listStatus={bot.listStatus} />;
    }
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://MEET.jit.si/room/#fragment"));
    await act(async () => {
      bot.actions.submit();
      bot.actions.submit();
      await Promise.resolve();
    });
    expect(creates).toHaveLength(1);
    expect(creates[0]!.url).toBe("https://MEET.jit.si/room/#fragment");
    expect(creates[0]!.key).toMatch(/^manual-v1-[0-9a-f-]{36}$/);
    expect(bot.form.checking).toBe(true);
    expect(host.querySelector("button")!.disabled).toBe(true);
    expect(host.textContent).toContain("Checking…");

    await act(async () => {
      releaseList({ status: "ok", value: { meetings: [activeMeeting("https://meet.jit.si/room/")] } });
      await Promise.resolve();
    });
    expect(bot.form.checking).toBe(false);
    expect(bot.form.active).toBe(true);
    expect(host.querySelector("button")!.disabled).toBe(true);
    bot.actions.submit();
    expect(creates).toHaveLength(1);
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index)!))
      .some(value => value?.includes(creates[0]!.key!))).toBe(true);
  });

  test("an unrelated unreadable row does not spin and a retry keeps the same key", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    let lists = 0;
    const keys: Array<string | undefined> = [];
    const client: TranscriberClient = {
      list: async () => {
        lists++;
        return { status: "ok", value: { meetings: [{ id: "mtg_unreadable", unavailable: true }] } };
      },
      create: async (_input, options) => { keys.push(options?.idempotencyKey); return { status: "offline" }; },
      get: async () => ({ status: "not-found" }),
      stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }),
      remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() {
      bot = useMeetingBot({
        backendUrl: "https://backend.example",
        sessionStore: { getToken: () => "token", isExpired: () => false } as SessionStore,
        client,
        calendar: { status: async () => ({ enabled: false, outcomes: [] }) },
        active: false,
      });
      return <SendNotetakerButton form={bot.form} listStatus={bot.listStatus} />;
    }
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/unreadable"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(lists).toBe(1);
    expect(bot.form.checking).toBe(false);
    expect(host.querySelector("button")!.disabled).toBe(false);
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  test("a retry after reload reuses both the key and original body fields", async () => {
    cleanupDom = installDom();
    const creates: Array<{ input: Parameters<TranscriberClient["create"]>[0]; key: string | undefined }> = [];
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: [] } }),
      create: async (input, options) => {
        creates.push({ input, key: options?.idempotencyKey });
        return { status: "offline" };
      },
      get: async () => ({ status: "not-found" }),
      stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }),
      remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    const Probe = () => {
      bot = useMeetingBot({
        backendUrl: "https://backend.example",
        sessionStore: { getToken: () => "token", isExpired: () => false } as SessionStore,
        client,
        calendar: { status: async () => ({ enabled: false, outcomes: [] }) },
        active: false,
      });
      return null;
    };
    const firstHost = document.createElement("div");
    document.body.append(firstHost);
    root = createRoot(firstHost);
    await act(async () => root!.render(<Probe />));
    await act(async () => {
      bot.actions.setUrl("https://MEET.jit.si/reload/#capability");
      bot.actions.setBotName("Original name");
    });
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(bot.form.checking).toBe(false);
    await act(async () => root!.unmount());

    const secondHost = document.createElement("div");
    document.body.append(secondHost);
    root = createRoot(secondHost);
    await act(async () => root!.render(<Probe />));
    await act(async () => {
      bot.actions.setUrl("https://meet.jit.si/reload");
      bot.actions.setBotName("Edited name");
    });
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(creates).toHaveLength(2);
    expect(creates[1]!.key).toBe(creates[0]!.key);
    expect(creates[1]!.input).toEqual(creates[0]!.input);
  });

  test("a new click after the represented bot ends mints a fresh key", async () => {
    cleanupDom = installDom();
    const creates: Array<{ key: string | undefined; id: string }> = [];
    let ended = false;
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: ended
        ? [{ ...activeMeeting("https://meet.jit.si/fresh"), status: "failed" }]
        : [] } }),
      create: async (input, options) => {
        const id = `mtg_${creates.length + 1}`;
        creates.push({ key: options?.idempotencyKey, id });
        return { status: "ok", value: activeMeeting(input.meeting_url) };
      },
      get: async () => ({ status: "not-found" }),
      stop: async (id) => { ended = true; return { status: "ok", value: { id, status: "failed" } }; },
      transcript: async () => ({ status: "not-found" }),
      remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() {
      bot = useMeetingBot({
        backendUrl: "https://backend.example",
        sessionStore: { getToken: () => "token", isExpired: () => false } as SessionStore,
        client,
        calendar: { status: async () => ({ enabled: false, outcomes: [] }) },
        active: false,
      });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/fresh"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    const firstKey = creates[0]!.key;
    expect(Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.getItem(window.sessionStorage.key(index)!))
      .some(value => value?.includes(firstKey!))).toBe(true);
    await act(async () => { bot.actions.stop("mtg_active"); await Bun.sleep(0); });
    await act(async () => bot.actions.setUrl("https://meet.jit.si/fresh"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(creates).toHaveLength(2);
    expect(creates[1]!.key).not.toBe(firstKey);
  });

  test("an old terminal row on a recurring URL does not rotate an ambiguous retry", async () => {
    cleanupDom = installDom();
    const url = "https://meet.jit.si/recurring";
    const old = { ...activeMeeting(url), id: "mtg_old", status: "completed" as const,
      created_at: "2026-01-01T00:00:00.000Z" };
    const older = { ...old, id: "mtg_older", created_at: "2025-01-01T00:00:00.000Z" };
    const keys: Array<string | undefined> = [];
    let creates = 0;
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: [old, older] } }),
      create: async (_input, options) => {
        keys.push(options?.idempotencyKey);
        return ++creates === 1 ? { status: "ok", value: old } : { status: "offline" };
      },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() {
      bot = useMeetingBot({ backendUrl: "https://backend.example",
        sessionStore: { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore,
        client, calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false });
      return null;
    }
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(bot.form.checking).toBe(false);
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[1]);
  });

  test("a terminal POST result clears the persisted intent before reload", async () => {
    cleanupDom = installDom();
    const url = "https://meet.jit.si/terminal-post";
    const keys: Array<string | undefined> = [];
    let terminal = true;
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: [] } }),
      create: async (input, options) => {
        keys.push(options?.idempotencyKey);
        if (terminal) return { status: "ok", value: { ...activeMeeting(input.meeting_url), status: "failed" } };
        return { status: "offline" };
      },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    const sessionStore = { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore;
    const Probe = () => { bot = useMeetingBot({ backendUrl: "https://backend.example", sessionStore, client,
      calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; };
    let host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    await act(async () => root!.unmount());
    terminal = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a newly terminal check result clears the persisted intent before reload", async () => {
    cleanupDom = installDom();
    const url = "https://meet.jit.si/terminal-check";
    const keys: Array<string | undefined> = [];
    let terminalCheck = true;
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: terminalCheck ? [{ ...activeMeeting(url), id: "mtg_new",
        status: "failed", created_at: new Date(Date.now() + 1_000).toISOString() }] : [] } }),
      create: async (_input, options) => { keys.push(options?.idempotencyKey); return { status: "offline" }; },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    const sessionStore = { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore;
    const Probe = () => { bot = useMeetingBot({ backendUrl: "https://backend.example", sessionStore, client,
      calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; };
    let host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    await act(async () => root!.unmount());
    terminalCheck = false;
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl(url));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("a conflict clears its key and shows a non-ambiguous retry error", async () => {
    cleanupDom = installDom();
    const keys: Array<string | undefined> = [];
    const client: TranscriberClient = {
      list: async () => ({ status: "ok", value: { meetings: [] } }),
      create: async (_input, options) => {
        keys.push(options?.idempotencyKey);
        return keys.length === 1
          ? { status: "rejected", httpStatus: 409, code: "idempotency_conflict", message: null }
          : { status: "offline" };
      },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() { bot = useMeetingBot({ backendUrl: "https://backend.example",
      sessionStore: { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore,
      client, calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/conflict"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(bot.form.checking).toBe(false);
    expect(bot.form.error).toContain("could not be retried safely");
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[1]).not.toBe(keys[0]);
  });

  test("unavailable checks stop after four reads and retry with the same key", async () => {
    cleanupDom = installDom();
    const timers: Array<() => void> = [];
    window.setTimeout = ((callback: TimerHandler) => { timers.push(callback as () => void); return timers.length; }) as typeof window.setTimeout;
    const keys: Array<string | undefined> = [];
    let lists = 0;
    const client: TranscriberClient = {
      list: async () => { lists++; return { status: "retryable", httpStatus: 503, code: "transcriber_unavailable" }; },
      create: async (_input, options) => { keys.push(options?.idempotencyKey); return { status: "offline" }; },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() { bot = useMeetingBot({ backendUrl: "https://backend.example",
      sessionStore: { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore,
      client, calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/bounded-check"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    for (let i = 0; i < 4; i++) {
      await act(async () => { timers.shift()?.(); await Bun.sleep(0); });
    }
    expect(lists).toBe(4);
    expect(bot.form.checking).toBe(false);
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[1]).toBe(keys[0]);
  });

  test("checking one URL leaves the inputs and a different URL available", async () => {
    cleanupDom = installDom();
    type ListResult = Awaited<ReturnType<TranscriberClient["list"]>>;
    let release!: (value: ListResult) => void;
    const held = new Promise<ListResult>(resolve => { release = resolve; });
    const urls: string[] = [];
    const client: TranscriberClient = {
      list: () => held,
      create: async (input) => { urls.push(input.meeting_url); return urls.length === 1
        ? { status: "offline" }
        : { status: "ok", value: activeMeeting(input.meeting_url) }; },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() { bot = useMeetingBot({ backendUrl: "https://backend.example",
      sessionStore: { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore,
      client, calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false });
      return <SendNotetakerButton form={bot.form} listStatus={bot.listStatus} />; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/one"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(bot.form.checking).toBe(true);
    await act(async () => bot.actions.setUrl("https://meet.jit.si/two"));
    expect(bot.form.checking).toBe(false);
    expect(host.querySelector("button")!.disabled).toBe(false);
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(urls).toEqual(["https://meet.jit.si/one", "https://meet.jit.si/two"]);
    await act(async () => {
      release({ status: "ok", value: { meetings: [] } });
      await Bun.sleep(0);
    });
  });

  test("a superseded check cannot confirm or clear the current intent", async () => {
    cleanupDom = installDom();
    type ListResult = Awaited<ReturnType<TranscriberClient["list"]>>;
    const releases: Array<(value: ListResult) => void> = [];
    const keys: Array<string | undefined> = [];
    const client: TranscriberClient = {
      list: () => new Promise<ListResult>(resolve => { releases.push(resolve); }),
      create: async (_input, options) => { keys.push(options?.idempotencyKey); return { status: "offline" }; },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    function Probe() { bot = useMeetingBot({ backendUrl: "https://backend.example",
      sessionStore: { getAddress: () => "0xaaa", getToken: () => "token", isExpired: () => false } as SessionStore,
      client, calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/first"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    await act(async () => bot.actions.setUrl("https://meet.jit.si/second"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(releases).toHaveLength(2);
    await act(async () => {
      releases[0]!({ status: "ok", value: { meetings: [activeMeeting("https://meet.jit.si/first")] } });
      await Bun.sleep(0);
    });
    expect(bot.form.checking).toBe(true);
    await act(async () => {
      releases[1]!({ status: "ok", value: { meetings: [] } });
      await Bun.sleep(0);
    });
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[2]).toBe(keys[1]);
  });

  test("an account switch drops the old account's check and send key", async () => {
    cleanupDom = installDom();
    type ListResult = Awaited<ReturnType<TranscriberClient["list"]>>;
    let release!: (value: ListResult) => void;
    const held = new Promise<ListResult>(resolve => { release = resolve; });
    const keys: Array<string | undefined> = [];
    let address = "0xaaa";
    let lists = 0;
    const client: TranscriberClient = {
      list: () => ++lists === 1 ? held : Promise.resolve({ status: "ok", value: { meetings: [] } }),
      create: async (_input, options) => { keys.push(options?.idempotencyKey); return { status: "offline" }; },
      get: async () => ({ status: "not-found" }), stop: async () => ({ status: "not-found" }),
      transcript: async () => ({ status: "not-found" }), remove: async () => ({ status: "not-found" }),
    };
    let bot!: MeetingBot;
    const sessionStore = { getAddress: () => address, getToken: () => "token", isExpired: () => false } as SessionStore;
    function Probe() { bot = useMeetingBot({ backendUrl: "https://backend.example", sessionStore, client,
      calendar: { status: async () => ({ enabled: false, outcomes: [] }) }, active: false }); return null; }
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => root!.render(<Probe />));
    await act(async () => bot.actions.setUrl("https://meet.jit.si/account-switch"));
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    address = "0xbbb";
    await act(async () => { root!.render(<Probe />); await Bun.sleep(0); });
    expect(bot.form.checking).toBe(false);
    expect(bot.form.error).toBeNull();
    await act(async () => {
      release({ status: "ok", value: { meetings: [activeMeeting("https://meet.jit.si/account-switch")] } });
      await Bun.sleep(0);
    });
    await act(async () => { bot.actions.submit(); await Bun.sleep(0); });
    expect(keys[1]).not.toBe(keys[0]);
  });
});
