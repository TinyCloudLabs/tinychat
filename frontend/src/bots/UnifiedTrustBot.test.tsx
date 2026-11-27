// Option A unified TrustBot tests: Feed's AskBox hands off straight to /chat/bot/main, sharing one live BotChats
// store and one useAsks instance with full TrustBot controls (settings, contextual access cards, ask/approval cards).
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { installDom } from "@/test/dom";
import { initSizeClass } from "@/lib/sizeClass";
import { ASK_STRINGS } from "./askStrings";
import type { BotChatApi } from "./botChatApi";
import type { BotRoster, BotRosterApi, RosterBot } from "./botRosterApi";
import type { AskDecision, AskRequest, BotsApi, MainEvent, SendOptions } from "./botsApi";
import { botsNavStore } from "./botsNav";
import { ChatSlot } from "./ChatSlot";
import { HomeAskBox } from "./HomeAskBox";
import { clearMainBotBridge, enqueueMainSend } from "./mainBotBridge";
import type { ReadSettings } from "./trustbotReadGrant";
import { BotsChat } from "./BotsChat";
import { MAIN_BOT } from "./BotAvatar";

let restore: (() => void) | undefined;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  clearMainBotBridge();
  botsNavStore.set(null);
  restore?.();
  restore = undefined;
});

const ACCOUNT = "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1";
const mainBot: RosterBot = {
  key: "main", name: "TrustBot", shape: "pebble", colour: "blue",
  environment: "private", state: "active", createdAt: "2026-11-18T00:00:00.000Z",
};
const roster: BotRoster = {
  bots: [mainBot],
  deleted: [],
  capMode: "flat3",
  limits: { private: { max: 3, used: 1 }, regular: { max: 0, used: 0 } },
  canCreate: { private: true, regular: false },
};

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function makeHarness(options: { admitted?: boolean; earlier?: { id: string; role: "user" | "bot"; text: string }[]; requests?: AskRequest[] } = {}) {
  const admitted = options.admitted ?? true;
  let requests = options.requests ?? [];
  const sends: { key: string; text: string; options?: SendOptions; emit: (event: MainEvent) => void; finish: () => void }[] = [];
  const decisions: { id: string; decision: AskDecision }[] = [];

  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: admitted }),
    listMainMessages: async () => (options.earlier ?? []).map((m) => ({ ...m, at: "" })),
    getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    setMainWeb: async (next) => ({ ...next, available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
    getAsks: async () => ({ enabled: true }),
    setAsks: async (next) => next,
    listRequests: async () => requests,
    answerRequest: async (id, decision) => {
      decisions.push({ id, decision: decision as AskDecision });
      requests = requests.map((r) => (r.id === id ? { ...r, state: decision.decision === "decline" ? "declined" : "answered", question: undefined } : r));
      return requests.find((r) => r.id === id)!;
    },
    sendToMain: async () => {},
  };

  const chatApi: BotChatApi = {
    listMessages: async (key) => (key === "main" ? (options.earlier ?? []).map((m) => ({ ...m, at: "" })) : []),
    send: (key, text, onEvent, _signal, sendOptions) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      sends.push({ key, text, options: sendOptions, emit: onEvent, finish: resolve });
      return promise;
    },
    readNotice: async () => null,
    acknowledgeNotice: async (_key, notice) => notice,
  };

  const rosterApi: BotRosterApi = {
    list: async () => roster,
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
    remove: async () => { throw new Error("unused"); },
  };

  return { api, chatApi, rosterApi, sends, decisions };
}

function Shell({ api, chatApi, rosterApi, tcw }: { api: BotsApi; chatApi: BotChatApi; rosterApi: BotRosterApi; tcw: TinyCloudWeb }) {
  const { pathname } = useLocation();
  const onChat = pathname.startsWith("/chat/bot/") || pathname === "/chat";
  return (
    <div>
      <span data-path="">{pathname}</span>
      <div className={onChat ? "" : "hidden"}>
        <ChatSlot account={ACCOUNT} tcw={tcw} active={onChat} api={api} chatApi={chatApi} rosterApi={rosterApi} history={null} classic={<p data-classic="">Classic</p>} />
      </div>
      {!onChat ? <HomeAskBox api={api} tcw={tcw} /> : null}
    </div>
  );
}

async function typeInto(area: HTMLTextAreaElement, value: string) {
  await act(async () => {
    area.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
}

test("sending from Feed's AskBox navigates straight to /chat/bot/main and streams live with existing history", async () => {
  restore = installDom();
  await import("./BotsSurface");
  const { api, chatApi, rosterApi, sends } = makeHarness({
    earlier: [{ id: "old-1", role: "bot", text: "Earlier **saved** reply" }],
  });
  const tcw = { did: ACCOUNT } as unknown as TinyCloudWeb;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);

  await act(async () => root!.render(
    <MemoryRouter initialEntries={["/chat/feed"]}>
      <Shell api={api} chatApi={chatApi} rosterApi={rosterApi} tcw={tcw} />
    </MemoryRouter>,
  ));
  await flush();
  await flush();

  // Feed shows the AskBox (no modal dialog).
  const field = host.querySelector<HTMLTextAreaElement>("[data-bots-ask] textarea")!;
  expect(field).not.toBeNull();
  await typeInto(field, "Summarize my last meeting");
  await act(async () => host.querySelector<HTMLButtonElement>('[data-bots-ask] button[type="submit"]')!.click());
  await flush();
  await flush();

  // Navigated straight to /chat/bot/main, no modal popup, history loaded, turn sent through shared store.
  expect(host.querySelector("[data-path]")!.textContent).toBe("/chat/bot/main");
  expect(host.querySelector('[data-bots-main-chat]')).toBeNull();
  expect(host.querySelector('[data-bot-view="main"]')).not.toBeNull();
  expect(host.textContent).toContain("Earlier saved reply");
  expect(sends).toHaveLength(1);
  expect(sends[0]!.key).toBe("main");
  expect(sends[0]!.text).toBe("Summarize my last meeting");

  await act(async () => {
    sends[0]!.emit({ type: "delta", text: "Here is your **summary**." });
    sends[0]!.emit({ type: "done", messageId: "m-new" });
    sends[0]!.finish();
  });
  await flush();
  expect(host.querySelector('[data-bot-view="main"]')!.textContent).toContain("Here is your summary.");
});

test("pending ask card appears on Feed while on Feed, moves cleanly into /chat/bot/main on open, and never duplicates", async () => {
  restore = installDom();
  await import("./BotsSurface");
  const pendingAsk: AskRequest = {
    id: "ask-1", kind: "ask", state: "pending",
    askedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    question: "Send follow-up?", outside: false, undelivered: false,
  };
  const { api, chatApi, rosterApi, sends, decisions } = makeHarness({ requests: [pendingAsk] });
  const tcw = { did: ACCOUNT } as unknown as TinyCloudWeb;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);

  await act(async () => root!.render(
    <MemoryRouter initialEntries={["/chat/feed"]}>
      <Shell api={api} chatApi={chatApi} rosterApi={rosterApi} tcw={tcw} />
    </MemoryRouter>,
  ));
  await flush();
  await flush();

  // Exactly one ask card, rendered on Feed.
  expect(host.querySelectorAll("[data-ask-card]")).toHaveLength(1);
  expect(host.querySelectorAll("[data-home-asks] [data-ask-card]")).toHaveLength(1);

  // Clicking TrustBot avatar navigates straight to /chat/bot/main; card now renders inside BotView only.
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Open TrustBot\'s chat"]')!.click());
  await flush();
  expect(host.querySelector("[data-path]")!.textContent).toBe("/chat/bot/main");
  expect(host.querySelectorAll("[data-ask-card]")).toHaveLength(1);
  expect(host.querySelectorAll('[data-bot-view="main"] [data-ask-card]')).toHaveLength(1);

  // Declining in BotView resolves the request and tells Main via appReply.
  const notNowBtn = [...host.querySelectorAll('[data-ask-card] button')].find((b) => b.textContent === "Not now")!;
  await act(async () => notNowBtn.click());
  await flush();
  expect(decisions).toEqual([{ id: "ask-1", decision: { decision: "decline" } }]);
  expect(sends).toHaveLength(1);
  expect(sends[0]!.options).toEqual({ appReply: { requestId: "ask-1" } });
  await act(async () => {
    sends[0]!.emit({ type: "delta", text: "Okay." });
    sends[0]!.emit({ type: "done", messageId: "m-2" });
    sends[0]!.finish();
  });
  await flush();
  // Live decline shows the collapsed outcome line (never duplicating a second app line).
  expect(host.querySelector("[data-ask-outcome]")!.textContent).toBe(ASK_STRINGS.declined);
  expect(host.querySelector('[data-bot-view="main"]')!.textContent).toContain("Okay.");
});

test("queued Feed send flushes once BotsChat mounts (cold-start handoff)", async () => {
  restore = installDom();
  enqueueMainSend(ACCOUNT, "Cold start prompt");
  const { api, chatApi, sends } = makeHarness();
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);

  await act(async () => root!.render(
    <BotsChat
      controller={{ status: "ready", roster: { bots: [mainBot] } }}
      selected="main"
      faceOf={() => MAIN_BOT}
      history={null}
      active
      chatApi={chatApi}
      account={ACCOUNT}
      mainApi={api}
    />,
  ));
  await flush();
  await flush();
  expect(sends).toHaveLength(1);
  expect(sends[0]!.key).toBe("main");
  expect(sends[0]!.text).toBe("Cold start prompt");
});

test("non-admitted accounts stay on Classic chat and see no Feed AskBox", async () => {
  restore = installDom();
  const { api, chatApi, rosterApi } = makeHarness({ admitted: false });
  const tcw = { did: ACCOUNT } as unknown as TinyCloudWeb;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);

  await act(async () => root!.render(
    <MemoryRouter initialEntries={["/chat/feed"]}>
      <Shell api={api} chatApi={chatApi} rosterApi={rosterApi} tcw={tcw} />
    </MemoryRouter>,
  ));
  await flush();
  await flush();

  expect(host.querySelector("[data-bots-ask]")).toBeNull();
  expect(host.querySelector('[data-chat-view="bots"]')).toBeNull();
  expect(host.querySelector('[data-chat-view="classic"]')!.className).not.toContain("hidden");
});

test("TrustBot settings panel opens from BotView and keeps ReadSettings synced with contextual access cards", async () => {
  restore = installDom();
  Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  const stopSize = initSizeClass(window);
  try {
    const { api } = makeHarness();
    const host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    const readSettings: ReadSettings = {
      enabled: true,
      serviceDid: "did:web:bots.test",
      grantActive: false,
      grantExpiresAt: null,
      standingAvailable: false,
      areas: { meetings: "off", feed_chats: "off", telegram: "off" },
    };
    const { BotView } = await import("./BotView");
    const { createBotChats } = await import("./useBotChat");
    const turns: { text: string; emit: (e: MainEvent) => void; finish: () => void }[] = [];
    const chats = createBotChats(() => ({
      list: async () => [],
      send: (_text, emit) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        turns.push({ text: _text, emit, finish: resolve });
        return promise;
      },
    }));

    await act(async () => root!.render(
      <BotView
        bot={{ key: "main", name: "TrustBot", private: true, face: MAIN_BOT }}
        chats={chats}
        acknowledgeNotice={async (n) => n}
        main={{
          active: true,
          webAccess: { getMainWeb: api.getMainWeb, setMainWeb: api.setMainWeb },
          meetings: {
            readSettings: async () => readSettings,
            setReadArea: async () => readSettings,
            signReadGrant: async () => ({ cid: "c1", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
            revokeReadGrant: async () => {},
          },
          onNotNow: (id, area) => chats.notNow("main", id, area),
          onAskAgain: (id) => chats.askAgain("main", id),
        }}
      />,
    ));
    await flush();

    // Send a question where TrustBot attempts meetings read while meetings is off.
    await act(async () => { void chats.send("main", "Summarize my meetings"); });
    await flush();
    await act(async () => {
      turns[0]!.emit({ type: "step", step: "meetings" });
      turns[0]!.emit({ type: "delta", text: "I need access to your meetings." });
      turns[0]!.emit({ type: "done", messageId: "m-1" });
      turns[0]!.finish();
    });
    await flush();

    // Contextual meetings access card renders inline in BotView.
    expect(host.querySelector('[data-bots-access-card="meetings"]')).not.toBeNull();

    // Settings button opens BotPanel containing TrustBot's settings.
    const settingsBtn = host.querySelector<HTMLButtonElement>('button[aria-label="TrustBot settings"]')!;
    expect(settingsBtn).not.toBeNull();
    await act(async () => settingsBtn.click());
    await flush();
    expect(host.querySelector("[data-bots-main-settings]")).not.toBeNull();

    chats.dispose();
  } finally {
    stopSize();
  }
});
