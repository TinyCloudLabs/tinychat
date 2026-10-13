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

  test("an unreadable owned row keeps ambiguous checking disabled", async () => {
    cleanupDom = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    let lists = 0;
    const client: TranscriberClient = {
      list: async () => {
        lists++;
        return { status: "ok", value: { meetings: [{ id: "mtg_unreadable", unavailable: true }] } };
      },
      create: async () => ({ status: "offline" }),
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
    expect(bot.form.checking).toBe(true);
    expect(host.querySelector("button")!.disabled).toBe(true);
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
});
