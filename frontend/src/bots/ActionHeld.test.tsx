// TC-3792: a Send tapped after the chat read the owner's meetings. The service answers 409 `held`; the card says so and
// Send stays off. Any other failed Send keeps the plain failure line.
import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ACTION_STRINGS } from "./actionStrings";
import { AskCards } from "./AskCards";
import { BotsHeld, type ActionRequest, createBotsApi } from "./botsApi";
import type { Asks, AskResult } from "./useAsks";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const proposal: ActionRequest = {
  id: "p1", kind: "action", action: "message_bots", state: "pending",
  askedAt: new Date(Date.now() - 3_600_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  outside: false, undelivered: false, targets: [{ key: "a".repeat(32), name: "Scout" }], text: "Status by noon.", binding: "c".repeat(64),
};

const asksAnswering = (result: AskResult): Asks => ({
  support: "yes", enabled: true, stopped: false, pending: [proposal], outcomes: [], webOn: false,
  setEnabled: async () => "ok", stop: async () => "ok", decide: async () => result, refresh: () => {},
} as unknown as Asks);

async function tapSend(result: AskResult) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<AskCards asks={asksAnswering(result)} />));
  const send = [...host.querySelectorAll("button")].find((node) => node.textContent === "Send")!;
  await act(async () => send.click());
  return { host, send };
}

test("a held Send shows the card's line and turns Send off", async () => {
  const { host, send } = await tapSend("held");
  expect(host.querySelector("[data-action-held]")!.textContent).toBe(ACTION_STRINGS.held);
  expect(host.textContent).not.toContain(ACTION_STRINGS.sendFailed);
  expect(send.disabled).toBe(true);
});

test("a failed Send keeps the plain failure line and Send stays on", async () => {
  const { host, send } = await tapSend("failed");
  expect(host.textContent).toContain(ACTION_STRINGS.sendFailed);
  expect(host.querySelector("[data-action-held]")).toBeNull();
  expect(send.disabled).toBe(false);
});

test("409 held from the backend is a BotsHeld; another 409 is a plain failure", async () => {
  const api = (response: Response) => createBotsApi({ baseUrl: "https://backend.test/", getToken: () => "t", fetch: async () => response });
  await expect(api(Response.json({ error: "held" }, { status: 409 })).answerRequest("p1", { decision: "approve", binding: "c".repeat(64) })).rejects.toBeInstanceOf(BotsHeld);
  await expect(api(Response.json({ error: "not_pending" }, { status: 409 })).answerRequest("p1", { decision: "approve", binding: "c".repeat(64) })).rejects.toMatchObject({ code: "failed" });
});
