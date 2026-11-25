import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { ACTION_STRINGS } from "./actionStrings";
import { AppLine, AskCards } from "./AskCards";
import type { ActionRequest, MainRequest } from "./botsApi";
import type { Asks } from "./useAsks";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const BINDING = "d".repeat(64);
const REPORT_ID = "01HZY3J5Q8V6K9W2X4N7M0P1RS";

const REPORT = {
  area: "other",
  kind: "bug",
  title: "Search shows an empty list",
  tried: "I searched my notes\nfor the planning meeting.",
  happened: "The page showed an empty list.",
  expected: "The planning meeting in the list.",
  agent: "TinyCloud One bot (TrustBot)",
};

const report = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  id: "f1",
  kind: "action",
  action: "send_feedback",
  state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 22 * 3_600_000).toISOString(),
  outside: false,
  undelivered: false,
  targets: [],
  text: JSON.stringify(REPORT),
  report: REPORT,
  binding: BINDING,
  ...over,
});

function asksWith(over: Partial<Asks> = {}, result: "ok" | "held" = "ok"): Asks & { decisions: unknown[] } {
  const state = {
    decisions: [] as unknown[],
    support: "yes" as const,
    enabled: true,
    stopped: false,
    pending: [] as MainRequest[],
    outcomes: [],
    secrets: [],
    saved: new Set<string>(),
    markSaved: () => {},
    dismiss: () => {},
    noteWeb: () => {},
    webOn: false,
    setEnabled: async () => "ok" as const,
    stop: async () => "ok" as const,
    decide: async (_request: MainRequest, decision: unknown) => { state.decisions.push(decision); return result; },
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

const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label);
const field = (host: Element, name: string) => host.querySelector(`[data-feedback-field="${name}"]`)?.textContent;

test("the card shows where the report goes, every field as written and what the team sees of the sender", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [report()] })} />);
  const card = host.querySelector("[data-feedback-card]")!;
  expect(card.textContent).toContain("TrustBot wants to send feedback to the TinyCloud team");
  expect(host.querySelector("[data-feedback-destination]")!.textContent).toBe("Goes to feedback.tinycloud.xyz. Only the TinyCloud team can read it.");
  for (const label of ["Title", "What I tried", "What happened", "What I expected"]) expect(card.textContent).toContain(label);
  for (const name of ["title", "tried", "happened", "expected", "area", "kind"] as const) expect(field(host, name)).toBe(REPORT[name]);
  expect(host.querySelector("[data-feedback-sender]")!.textContent).toBe("Sent without your name or account, so the team can't reply to you.");
  expect(host.querySelector("[data-feedback-agent]")!.textContent).toBe("Sent as: TinyCloud One bot (TrustBot)");
  expect(host.querySelector("[data-action-outside]")).toBeNull();
  expect(button(host, "Send report")).toBeTruthy();
  expect(button(host, "Don't send")).toBeTruthy();
  // A message to bots keeps its own card.
  expect(button(host, "Send")).toBeUndefined();
});

test("the outside warning shows when the bot read something from outside first", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [report({ outside: true })] })} />);
  expect(host.querySelector("[data-action-outside]")!.textContent).toBe(ACTION_STRINGS.outside);
});

test("Send report names the binding the card came with; Don't send declines", async () => {
  const asks = asksWith({ pending: [report()] });
  const host = await render(<AskCards asks={asks} />);
  await act(async () => button(host, "Send report")!.click());
  await act(async () => button(host, "Don't send")!.click());
  expect(asks.decisions).toEqual([{ decision: "approve", binding: BINDING }, { decision: "decline" }]);
});

test("a card without its binding or its report cannot be sent", async () => {
  for (const over of [{ binding: undefined }, { report: undefined }]) {
    const host = await render(<AskCards asks={asksWith({ pending: [report(over)] })} />);
    expect(button(host, "Send report")!.disabled).toBe(true);
    act(() => mounted!.unmount());
    mounted = undefined;
    restore?.();
    restore = undefined;
  }
});

test("a Send from a chat that holds private data says it was not sent", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [report()] }, "held")} />);
  await act(async () => button(host, "Send report")!.click());
  expect(host.querySelector("[data-action-held]")!.textContent).toBe("Not sent. This chat holds your private data, or the request ended.");
  expect(button(host, "Send report")!.disabled).toBe(true);
});

test("after the tap the card collapses to one line for each outcome", async () => {
  const sent = (id: string, feedback: ActionRequest["feedback"]) => report({ id, state: "done", text: undefined, report: undefined, binding: undefined, feedback });
  const host = await render(<AskCards outcomes asks={asksWith({
    outcomes: [
      { id: "s0", kind: "action", request: report({ id: "s0", state: "sending" }) },
      { id: "s1", kind: "action", request: sent("s1", { outcome: "filed", reportId: REPORT_ID }) },
      { id: "s2", kind: "action", request: sent("s2", { outcome: "filed", reportId: "short-id" }) },
      { id: "s3", kind: "action", request: sent("s3", { outcome: "rate_limited" }) },
      { id: "s4", kind: "action", request: sent("s4", { outcome: "busy" }) },
      { id: "s5", kind: "action", request: sent("s5", { outcome: "rejected" }) },
      { id: "s6", kind: "action", request: sent("s6", { outcome: "unknown" }) },
      { id: "s7", kind: "action", request: sent("s7", { outcome: "refused" }) },
      { id: "s8", kind: "action", request: sent("s8", undefined) },
      { id: "s9", kind: "action", request: report({ id: "s9", state: "declined" }) },
    ],
  })} />);
  expect([...host.querySelectorAll("[data-action-outcome]")].map((node) => node.textContent)).toEqual([
    ACTION_STRINGS.sending,
    `Sent. Report ${REPORT_ID}.`,
    "Sent.",
    "Not sent: the feedback service is taking too many reports. Ask TrustBot to try in a few minutes.",
    "Not sent: the feedback service is busy. Ask TrustBot to try in a few hours.",
    "Not sent: the feedback service refused this report.",
    "This report may have been sent. If you ask TrustBot to resend it, the team may get two copies.",
    "Not sent. This chat holds your private data, or the request ended.",
    "This report may have been sent. If you ask TrustBot to resend it, the team may get two copies.",
    ACTION_STRINGS.declined,
  ]);
});

test("a report's decision has no chat line", async () => {
  const host = await render(<>
    <AppLine decision="feedback_sent" live />
    <AppLine decision="feedback_declined" live={false} />
  </>);
  expect(host.querySelectorAll("[data-app-line]")).toHaveLength(0);
});
