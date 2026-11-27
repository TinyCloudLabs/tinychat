import { afterEach, expect, mock, test } from "bun:test";
import { act, useEffect, useRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { createBotsApi, type BotsApi, type MainEvent } from "./botsApi";
import { botsErrorText } from "./botsStrings";
import { useMainChat } from "./useMainChat";

// Radix portals do not attach in happy-dom: only the dialog shell is an inline stand-in; the real body and footer stay, since bun's mock.module is process-wide.
const actualSheet = await import("../components/ui/responsive-sheet");
mock.module("../components/ui/responsive-sheet", () => ({
  ...actualSheet,
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div role="dialog"><h2>{props.title}</h2>{props.children}<div>{props.footer}</div></div> : null,
}));
const { MainChat } = await import("./MainChat");

const LINE = "TrustBot can't start right now because TinyCloud is running as many bots as it can. Your message wasn't sent. Try again shortly.";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

test("the service's at_capacity error event keeps its own code", async () => {
  const body = 'event: status\ndata: {"state":"starting"}\n\nevent: error\ndata: {"code":"at_capacity","message":"x"}\n\n';
  const api = createBotsApi({
    baseUrl: "https://backend.test/",
    getToken: () => "session-token",
    fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  });
  const events: MainEvent[] = [];
  await api.sendToMain("hi", (event) => events.push(event));
  expect(events.at(-1)).toEqual({ type: "error", code: "at_capacity" });
});

test("the line names the bot, and Main when no name is given", () => {
  expect(botsErrorText("at_capacity")).toBe(LINE);
  expect(botsErrorText("at_capacity", "Scout")).toStartWith("Scout can't start right now");
  expect(botsErrorText("bot_unavailable")).toBe("TrustBot can't be reached right now.");
});

function Harness({ api, sent }: { api: BotsApi; sent: string[] }) {
  const chat = useMainChat({ ...api, sendToMain: (text, onEvent, signal) => { sent.push(text); return api.sendToMain(text, onEvent, signal); } });
  const send = chat.send;
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void send("do the thing");
  }, [send]);
  return <MainChat open onOpenChange={() => {}} state={chat.state} onSend={(text) => void chat.send(text)} onRetry={chat.retry} onRetryHistory={chat.loadHistory} />;
}

test("a full service shows the line with Try again, which sends the same message again and then goes through", async () => {
  restore = installDom();
  let attempt = 0;
  const api: BotsApi = {
    getBotsStatus: async () => ({ enabled: true }),
    listMainMessages: async () => [],
    sendToMain: async (_text, onEvent) => {
      attempt++;
      if (attempt === 1) onEvent({ type: "error", code: "at_capacity" });
      else {
        onEvent({ type: "delta", text: "pong" });
        onEvent({ type: "done", messageId: "m-1" });
      }
    },
  };
  const sent: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
  await act(async () => root.render(<Harness api={api} sent={sent} />));
  await flush();

  const alert = document.body.querySelector('[role="alert"]')!;
  expect(alert.querySelector("p")?.textContent).toBe(LINE);
  const retry = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
  await act(async () => { retry.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();

  expect(sent).toEqual(["do the thing", "do the thing"]);
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).toContain("pong");
});
