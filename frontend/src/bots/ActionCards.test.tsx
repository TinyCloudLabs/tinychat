import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ACTION_STRINGS } from "./actionStrings";
import { AppLine, AskCards } from "./AskCards";
import type { ActionRequest, BotRequest } from "./botsApi";
import type { Asks } from "./useAsks";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const BINDING = "c".repeat(64);

const proposal = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  id: "p1",
  kind: "action",
  action: "message_bots",
  state: "pending",
  askedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 22 * 3_600_000).toISOString(),
  outside: false,
  undelivered: false,
  targets: [{ key: "a".repeat(32), name: "Scout" }, { key: "b".repeat(32), name: "Ledger" }],
  text: "Please each send me\nyour status by noon.",
  binding: BINDING,
  ...over,
});

function asksWith(over: Partial<Asks> = {}): Asks & { decisions: unknown[] } {
  const state = {
    decisions: [] as unknown[],
    support: "yes" as const,
    enabled: true,
    stopped: false,
    pending: [] as BotRequest[],
    outcomes: [],
    webOn: false,
    setEnabled: async () => "ok" as const,
    stop: async () => "ok" as const,
    decide: async (_request: BotRequest, decision: unknown) => { state.decisions.push(decision); return "ok" as const; },
    refresh: () => {},
    ...over,
  };
  return state;
}

async function render(node: React.ReactElement) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(node));
  return host;
}

const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;

test("the card's words are the app's, around the recipients' names and Main's message as written", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [proposal()] })} />);
  const card = host.querySelector("[data-action-card]")!;
  expect(card.textContent).toContain("Main wants to send this message to Scout and Ledger:");
  expect(card.textContent).toContain("Written by Main");
  expect(host.querySelector("[data-action-text]")!.textContent).toBe("Please each send me\nyour status by noon.");
  expect(card.textContent).toContain(ACTION_STRINGS.footer);
  expect(host.querySelector("[data-action-outside]")).toBeNull();
  expect(button(host, "Send")).toBeTruthy();
  expect(button(host, "Don’t send")).toBeTruthy();
});

test("hidden and direction-changing characters in the message or a name do not reach the card, and a gone bot reads as deleted", async () => {
  const host = await render(<AskCards asks={asksWith({
    pending: [proposal({
      text: "Pay\u202e now\u200b please",
      targets: [{ key: "a".repeat(32), name: "Sc\u202eout" }, { key: "b".repeat(32), name: null }],
      outside: true,
    })],
  })} />);
  expect(host.querySelector("[data-action-text]")!.textContent).toBe("Pay now please");
  expect(host.textContent).toContain("Main wants to send this message to Sc out and a deleted bot:");
  expect(host.querySelector("[data-action-outside]")!.textContent).toBe(ACTION_STRINGS.outside);
});

test("Send names the binding the card came with; Don't send declines", async () => {
  const asks = asksWith({ pending: [proposal()] });
  const host = await render(<AskCards asks={asks} />);
  await act(async () => button(host, "Send").click());
  await act(async () => button(host, "Don’t send").click());
  expect(asks.decisions).toEqual([{ decision: "approve", binding: BINDING }, { decision: "decline" }]);
});

test("a card without its binding cannot be sent", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [proposal({ binding: undefined })] })} />);
  expect(button(host, "Send").disabled).toBe(true);
});

test("in Main's chat a decided card collapses to what happened, by recipient", async () => {
  const done = proposal({
    state: "done", text: undefined, binding: undefined,
    outcomes: [{ key: "a".repeat(32), delivered: true }, { key: "b".repeat(32), delivered: false }],
  });
  const host = await render(<AskCards outcomes asks={asksWith({
    outcomes: [
      { id: "p1", kind: "action", request: done },
      { id: "p2", kind: "action", request: proposal({ id: "p2", state: "sending" }) },
      { id: "p3", kind: "action", request: proposal({ id: "p3", state: "expired" }) },
    ],
  })} />);
  const lines = [...host.querySelectorAll("[data-action-outcome]")].map((node) => node.textContent);
  expect(lines).toEqual(["Sent to Scout. Couldn’t reach Ledger.", "Sending…", "This request expired. Nothing was sent."]);
});

test("the chat line for a decision names the recipients when known, and says other bots after a reload", async () => {
  const host = await render(<>
    <AppLine decision="action_approved" live names={["Scout", "Ledger"]} />
    <AppLine decision="action_declined" live={false} />
  </>);
  expect([...host.querySelectorAll("[data-app-line]")].map((node) => node.textContent)).toEqual([
    "You sent Main’s message to Scout and Ledger.",
    "You chose not to send Main’s message to other bots.",
  ]);
});
