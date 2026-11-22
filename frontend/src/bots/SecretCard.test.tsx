import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { AppLine } from "./AskCards";
import { ASK_STRINGS, SECRET_STRINGS, secretDate } from "./askStrings";
import type { SecretRequest } from "./botsApi";
import { MAIN_BOT_NAME } from "./botsStrings";
import { isSavedSignal, SAVED_SIGNAL, SecretCards, SECRETS_ORIGIN } from "./SecretCard";
import type { Asks } from "./useAsks";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
  setSecretsAvailableForTests(null);
});

const UNTIL = "2026-11-22T13:12:00.000Z";
const APPROVE = "https://openkey.so/approve/secret?request=abc";

const request = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: "s1",
  kind: "secret",
  state: "pending",
  askedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 22 * 3_600_000).toISOString(),
  name: "OPENAI_API_KEY",
  sites: ["api.openai.com"],
  service: "OpenAI",
  why: "To summarise your notes with your own OpenAI account.",
  approveUrl: APPROVE,
  outside: false,
  undelivered: false,
  ...over,
});

type FakeAsks = Asks & { decisions: unknown[]; marked: string[]; dismissed: string[]; stops: number; refreshes: number };

function asksWith(over: Partial<Asks> = {}): FakeAsks {
  const state: FakeAsks = {
    decisions: [], marked: [], dismissed: [], stops: 0, refreshes: 0,
    support: "yes", enabled: true, stopped: false, pending: [], outcomes: [], secrets: [], saved: new Set(),
    owner: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
    webOn: false,
    noteWeb: () => {},
    markSaved: (id) => { state.marked.push(id); },
    dismiss: (id) => { state.dismissed.push(id); },
    setEnabled: async () => "ok",
    stop: async () => { state.stops++; return "ok"; },
    decide: async (_request, decision) => { state.decisions.push(decision); return "ok"; },
    refresh: () => { state.refreshes++; },
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

const text = (host: Element) => host.textContent ?? "";
const button = (host: Element, label: string) => {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
};
const click = async (target: HTMLElement) => act(async () => target.click());

/** Replaces window.open; each call is recorded and gets a fake window (or null, as a blocker does). */
function stubOpen(blocked = false) {
  const calls: { url: string; name: string; features: string; window: { closed: boolean } }[] = [];
  (window as unknown as { open: unknown }).open = (url: string, name: string, features: string) => {
    if (blocked) return null;
    const opened = { closed: false };
    calls.push({ url, name, features, window: opened });
    return opened;
  };
  return calls;
}

async function post(data: unknown, origin: string, source: unknown) {
  await act(async () => {
    window.dispatchEvent(new (window as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent("message", { data, origin, source: source as MessageEventSource }));
  });
}

test("a pending request in Main's chat is the card in the design's words, with both steps", async () => {
  setSecretsAvailableForTests(true);
  const host = await render(<SecretCards asks={asksWith({ secrets: [request({ outside: true })] })} chat onMessage={() => {}} />);
  for (const line of [
    SECRET_STRINGS.title, "“To summarise your notes with your own OpenAI account.”", "Only with: OpenAI (api.openai.com)", "Asked 2 minutes ago",
    SECRET_STRINGS.outside, SECRET_STRINGS.addTitle, SECRET_STRINGS.addHelp, SECRET_STRINGS.approveTitle, SECRET_STRINGS.approveHelp,
    `${MAIN_BOT_NAME} can use it only with OpenAI and can’t see or show its value.`, SECRET_STRINGS.decline, SECRET_STRINGS.message, ASK_STRINGS.stop,
  ]) expect(text(host)).toContain(line);
  expect(SECRET_STRINGS.title).toBe(`${MAIN_BOT_NAME} is asking to use a secret`);
  // Approving comes after the secret is in TinyCloud Secrets.
  expect(button(host, SECRET_STRINGS.approveButton).disabled).toBe(true);
});

test("an unknown secret names its sites: on the card as a list, in sentences joined with and", async () => {
  setSecretsAvailableForTests(true);
  const unknown = request({ name: "ACME_TOKEN", service: undefined, sites: ["api.acme.test", "eu.acme.test", "us.acme.test"] });
  const host = await render(<SecretCards asks={asksWith({ secrets: [unknown] })} chat />);
  expect(text(host)).toContain("Only with: api.acme.test, eu.acme.test, us.acme.test");
  expect(text(host)).toContain(`${MAIN_BOT_NAME} can use it only with api.acme.test, eu.acme.test and us.acme.test and can’t see or show its value.`);
});

test("a secret Main may also write with says so; one it can only read with does not", async () => {
  setSecretsAvailableForTests(true);
  const host = await render(<SecretCards asks={asksWith({ secrets: [request({ writes: ["POST"] }), request({ id: "s2", name: "GITHUB_TOKEN", service: "GitHub PAT", sites: ["api.github.com"] })] })} chat />);
  expect([...host.querySelectorAll("[data-secret-writes]")].map((line) => line.textContent)).toEqual([
    `${MAIN_BOT_NAME} can also send data to OpenAI with it, which may cost money or change things there.`,
  ]);
});

test("Open TinyCloud Secrets opens a named pop-up for this secret with a fresh state, and says where to finish", async () => {
  setSecretsAvailableForTests(true);
  const asks = asksWith({ secrets: [request()] });
  const host = await render(<SecretCards asks={asks} chat />);
  const calls = stubOpen();
  await click(button(host, SECRET_STRINGS.addButton));
  await click(button(host, SECRET_STRINGS.addButton));
  expect(calls).toHaveLength(2);
  const [first, second] = calls.map((call) => new URL(call.url));
  expect(first!.origin + first!.pathname).toBe(`${SECRETS_ORIGIN}/request`);
  expect(Object.fromEntries(first!.searchParams)).toMatchObject({
    owner: asks.owner, name: "OPENAI_API_KEY", requester: "TinyCloud One", return_to: window.location.origin,
  });
  expect(first!.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
  expect(second!.searchParams.get("state")).not.toBe(first!.searchParams.get("state"));
  expect(calls[0]!.name).toBe("tinycloud-secrets-s1");
  expect(calls[0]!.features).not.toContain("noopener");
  expect(host.querySelector("[data-secret-window=open]")!.textContent).toBe(SECRET_STRINGS.windowOpen);
});

test("a blocked pop-up says so", async () => {
  setSecretsAvailableForTests(true);
  const host = await render(<SecretCards asks={asksWith({ secrets: [request()] })} chat />);
  stubOpen(true);
  await click(button(host, SECRET_STRINGS.addButton));
  expect(host.querySelector("[data-secret-window=blocked]")!.textContent).toBe(SECRET_STRINGS.windowBlocked);
});

test("the saved signal is taken only from TinyCloud Secrets, from the window this card opened, in its exact shape, with its state, once", async () => {
  setSecretsAvailableForTests(true);
  const asks = asksWith({ secrets: [request()] });
  const host = await render(<SecretCards asks={asks} chat />);
  const calls = stubOpen();
  await click(button(host, SECRET_STRINGS.addButton));
  const popup = calls[0]!.window;
  const state = new URL(calls[0]!.url).searchParams.get("state")!;
  const good = { type: SAVED_SIGNAL, v: 1, names: ["OPENAI_API_KEY"], state };
  await post(good, "https://evil.test", popup);
  await post(good, SECRETS_ORIGIN, {});
  await post({ ...good, scope: "x" }, SECRETS_ORIGIN, popup);
  await post({ ...good, state: "f".repeat(32) }, SECRETS_ORIGIN, popup);
  await post({ ...good, names: ["OTHER_KEY"] }, SECRETS_ORIGIN, popup);
  await post({ ...good, names: ["OPENAI_API_KEY", "OTHER_KEY"] }, SECRETS_ORIGIN, popup);
  await post({ ...good, v: 2 }, SECRETS_ORIGIN, popup);
  expect(asks.marked).toEqual([]);
  await post(good, SECRETS_ORIGIN, popup);
  await post(good, SECRETS_ORIGIN, popup);
  expect(asks.marked).toEqual(["s1"]);
  expect(host.querySelector("[data-secret-window]")).toBeNull();
});

test("isSavedSignal takes only a plain object with exactly the four keys", () => {
  const good = { type: SAVED_SIGNAL, v: 1, names: ["A"], state: "s" };
  expect(isSavedSignal(good, "A", "s")).toBe(true);
  expect(isSavedSignal(good, "A", "")).toBe(false);
  expect(isSavedSignal({ ...good, state: "" }, "A", "")).toBe(false);
  expect(isSavedSignal(Object.assign(Object.create({ inherited: 1 }), good), "A", "s")).toBe(false);
  expect(isSavedSignal([good], "A", "s")).toBe(false);
  expect(isSavedSignal(JSON.stringify(good), "A", "s")).toBe(false);
  const { v: _v, ...missing } = good;
  expect(isSavedSignal(missing, "A", "s")).toBe(false);
});

test("once saved, step 1 is done and Approve in OpenKey opens the approval page; the list is read again when it closes", async () => {
  setSecretsAvailableForTests(true);
  const asks = asksWith({ secrets: [request()], saved: new Set(["s1"]) });
  const host = await render(<SecretCards asks={asks} chat />);
  expect(host.querySelector("[data-secret-step-done=add]")!.textContent).toBe(SECRET_STRINGS.addDone);
  const calls = stubOpen();
  const approve = button(host, SECRET_STRINGS.approveButton);
  expect(approve.disabled).toBe(false);
  await click(approve);
  expect(calls.map((call) => [call.url, call.name])).toEqual([[APPROVE, "openkey-approve-s1"]]);
  calls[0]!.window.closed = true;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  expect(asks.refreshes).toBe(1);
  expect(host.querySelector("[data-secret-window]")).toBeNull();
});

test("an approval link that is not OpenKey's is never opened", async () => {
  setSecretsAvailableForTests(true);
  const host = await render(<SecretCards asks={asksWith({ secrets: [request({ approveUrl: "https://evil.test/approve" })], saved: new Set(["s1"]) })} chat />);
  expect(button(host, SECRET_STRINGS.approveButton).disabled).toBe(true);
});

test("on iPhone the card says where to add or approve it, with Decline only", async () => {
  setSecretsAvailableForTests(false);
  const asks = asksWith({ secrets: [request()] });
  const host = await render(<SecretCards asks={asks} chat onMessage={() => {}} />);
  expect(host.querySelector("[data-secret-iphone]")!.textContent).toBe("To add or approve a secret, open TinyCloud One on the web or desktop.");
  expect([...host.querySelectorAll("button")].map((candidate) => candidate.textContent)).toEqual([SECRET_STRINGS.decline]);
  await click(button(host, SECRET_STRINGS.decline));
  expect(asks.decisions).toEqual([{ decision: "decline" }]);
});

test("Decline and Stop Main from asking act on the request and the setting", async () => {
  setSecretsAvailableForTests(true);
  const asks = asksWith({ secrets: [request()] });
  const host = await render(<SecretCards asks={asks} chat />);
  await click(button(host, SECRET_STRINGS.decline));
  await click(button(host, ASK_STRINGS.stop));
  expect(asks.decisions).toEqual([{ decision: "decline" }]);
  expect(asks.stops).toBe(1);
});

test("an approved request says until when, and stopping it asks first", async () => {
  const asks = asksWith({ secrets: [request({ state: "approved", until: UNTIL, approveUrl: undefined })] });
  const host = await render(<SecretCards asks={asks} />);
  const until = secretDate(UNTIL);
  expect(host.querySelector("[data-secret-approved]")!.textContent).toBe(`✓ ${MAIN_BOT_NAME} can use OPENAI_API_KEY with OpenAI until ${until}.`);
  expect(text(host)).toContain(SECRET_STRINGS.approvedHelp);
  await click(button(host, SECRET_STRINGS.stopNow));
  expect(text(host)).toContain(`Stop ${MAIN_BOT_NAME} using OPENAI_API_KEY?`);
  expect(text(host)).toContain(`${MAIN_BOT_NAME} can’t use it after this. It stays in your TinyCloud Secrets.`);
  await click(button(host, SECRET_STRINGS.cancel));
  expect(asks.decisions).toEqual([]);
  await click(button(host, SECRET_STRINGS.stopNow));
  await click(button(host, SECRET_STRINGS.stopNow));
  expect(asks.decisions).toEqual([{ decision: "stop" }]);
});

test("each resolved state has its words and a Close that closes the card for good", async () => {
  const cases: [Partial<SecretRequest>, string[]][] = [
    [{ state: "revoked" }, [`Stopped. ${MAIN_BOT_NAME} can’t use OPENAI_API_KEY.`]],
    [{ state: "declined" }, ["You declined. Nothing was shared.", "OPENAI_API_KEY · only with OpenAI"]],
    [{ state: "expired" }, ["This request expired. Nothing was shared.", "OPENAI_API_KEY · only with OpenAI"]],
    [{ state: "ended", until: UNTIL }, [`${MAIN_BOT_NAME}’s access to OPENAI_API_KEY ended on ${secretDate(UNTIL)}.`, `If ${MAIN_BOT_NAME} needs it later, you’ll see a new request.`]],
    [{ state: "failed" }, [`Something went wrong, so ${MAIN_BOT_NAME} can’t use OPENAI_API_KEY yet. Nothing was shared.`, SECRET_STRINGS.tryAgain]],
  ];
  for (const [over, lines] of cases) {
    const asks = asksWith({ secrets: [request(over)] });
    const host = await render(<SecretCards asks={asks} />);
    for (const line of lines) expect(text(host)).toContain(line);
    await click(button(host, SECRET_STRINGS.close));
    expect(asks.dismissed).toEqual(["s1"]);
    act(() => mounted!.unmount());
    mounted = undefined;
    restore!();
    restore = undefined;
  }
});

test("Try again asks the service to retry a failed request", async () => {
  const asks = asksWith({ secrets: [request({ state: "failed" })] });
  const host = await render(<SecretCards asks={asks} />);
  await click(button(host, SECRET_STRINGS.tryAgain));
  expect(asks.decisions).toEqual([{ decision: "retry" }]);
});

test("in Main's chat an expired or ended request adds its line for the owner", async () => {
  const host = await render(<SecretCards asks={asksWith({ secrets: [request({ state: "expired" }), request({ id: "s2", state: "ended", until: UNTIL })] })} chat />);
  expect([...host.querySelectorAll("[data-app-line]")].map((line) => line.textContent)).toEqual([
    `${MAIN_BOT_NAME}’s request for OPENAI_API_KEY expired.`, `${MAIN_BOT_NAME}’s access to OPENAI_API_KEY ended.`,
  ]);
});

test("in Feed a pending request is a Needs you row that opens in place; Open chat opens Main's chat", async () => {
  setSecretsAvailableForTests(true);
  let opened = 0;
  const host = await render(<SecretCards asks={asksWith({ secrets: [request()] })} onMessage={() => { opened++; }} />);
  const row = host.querySelector("[data-secret-row]")!;
  expect(row.textContent).toBe(`Needs you${MAIN_BOT_NAME} is asking to use OPENAI_API_KEYOnly with OpenAI · asked 2 minutes ago · Open chat`);
  await click(button(host, SECRET_STRINGS.openChat));
  expect(opened).toBe(1);
  await click(row.querySelector("button[aria-expanded]") as HTMLButtonElement);
  expect(host.querySelector("[data-secret-row]")).toBeNull();
  expect(host.querySelector("[data-secret-card][data-secret-state=pending]")).not.toBeNull();
  expect(text(host)).toContain(SECRET_STRINGS.addButton);
});

test("chat lines for secret decisions name the secret; a decline just made is on the card instead", async () => {
  const secret = { name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", until: UNTIL };
  const host = await render(<>
    <AppLine decision="approved" live={false} secret={secret} />
    <AppLine decision="revoked" live={false} secret={secret} />
    <AppLine decision="declined" live={false} secret={secret} />
    <AppLine decision="declined" live secret={secret} />
    <AppLine decision="stopped" live={false} />
  </>);
  expect([...host.querySelectorAll("[data-app-line]")].map((line) => line.textContent)).toEqual([
    `You let ${MAIN_BOT_NAME} use OPENAI_API_KEY with OpenAI until ${secretDate(UNTIL)}.`,
    `You stopped ${MAIN_BOT_NAME} using OPENAI_API_KEY.`,
    `You declined ${MAIN_BOT_NAME}’s request for OPENAI_API_KEY.`,
    `You turned off questions and requests from ${MAIN_BOT_NAME}, so its open questions and secret requests were closed.`,
  ]);
});

test("dates read as short weekday, day, short month and 24-hour time", () => {
  expect(secretDate(UNTIL)).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec), \d{2}:\d{2}$/);
});
