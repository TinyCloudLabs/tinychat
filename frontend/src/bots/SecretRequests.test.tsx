import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { SECRET_STRINGS } from "./askStrings";
import { createBotsApi, type MainRequest, type SecretRequest } from "./botsApi";
import { SecretCards } from "./SecretCard";
import { CLOSED_SECRETS_KEY, useAsks, type AsksApi } from "./useAsks";
import type { AppReply } from "./useMainChat";

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
const secret = (over: Partial<SecretRequest> = {}): SecretRequest => ({
  id: "s1", kind: "secret", state: "pending",
  askedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", outside: false, undelivered: false,
  ...over,
});

function fakeApi(list: () => MainRequest[], answer: (id: string, decision: unknown) => MainRequest = () => { throw new Error("no"); }) {
  const answers: unknown[] = [];
  const api: AsksApi = {
    getAsks: async () => ({ enabled: true }),
    setAsks: async ({ enabled }) => ({ enabled }),
    listRequests: async () => list(),
    answerRequest: async (id, decision) => { answers.push(decision); return answer(id, decision); },
    getMainWeb: async () => ({ mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } }),
  };
  return { api, answers };
}

function Probe({ api, replies }: { api: AsksApi; replies: AppReply[] }) {
  const asks = useAsks(api, { open: true, onDecided: (reply) => replies.push(reply) });
  return <SecretCards asks={asks} chat />;
}

async function mount(api: AsksApi, replies: AppReply[], storage?: Storage) {
  restore ??= installDom(storage ? { localStorage: storage } : undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<Probe api={api} replies={replies} />));
  await act(async () => { await Promise.resolve(); });
  return host;
}

const click = async (host: Element, label: string) => {
  const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent === label) as HTMLButtonElement;
  await act(async () => found.click());
};

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

test("an approval not yet told to Main goes out once, naming the secret, and its card stays until closed, across a reload", async () => {
  const storage = memoryStorage();
  const approved = secret({ state: "approved", until: UNTIL, undelivered: true });
  const replies: AppReply[] = [];
  const { api } = fakeApi(() => [approved]);
  const host = await mount(api, replies, storage);
  expect(replies).toEqual([{ requestId: "s1", decision: "approved", secret: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", until: UNTIL } }]);
  expect(host.querySelector("[data-secret-state=approved]")).not.toBeNull();
  await click(host, SECRET_STRINGS.close);
  expect(host.querySelector("[data-secret-card]")).toBeNull();
  expect(JSON.parse(storage.getItem(CLOSED_SECRETS_KEY)!)).toEqual(["s1"]);

  act(() => mounted!.unmount());
  const again = await mount(fakeApi(() => [{ ...approved, undelivered: false }]).api, [], storage);
  expect(again.querySelector("[data-secret-card]")).toBeNull();
});

test("declining a request the owner is looking at tells Main once and leaves the declined card", async () => {
  setSecretsAvailableForTests(true);
  const replies: AppReply[] = [];
  let state: SecretRequest = secret();
  const { api, answers } = fakeApi(() => [state], () => {
    state = secret({ state: "declined", undelivered: true, resolvedAt: new Date().toISOString() });
    return state;
  });
  const host = await mount(api, replies);
  await click(host, SECRET_STRINGS.decline);
  expect(answers).toEqual([{ decision: "decline" }]);
  expect(host.querySelector("[data-secret-state=declined]")!.textContent).toContain("You declined. Nothing was shared.");
  // A later read that still says undelivered does not send it again.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(replies).toEqual([{ requestId: "s1", decision: "declined", secret: { name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI" } }]);
});

test("a decline, expiry or switch-off the owner never saw shows no card", async () => {
  const replies: AppReply[] = [];
  const { api } = fakeApi(() => [
    secret({ id: "a", state: "declined" }), secret({ id: "b", state: "expired" }), secret({ id: "c", state: "stopped" }), secret({ id: "d", state: "revoked" }),
  ]);
  const host = await mount(api, replies);
  expect(host.querySelector("[data-secret-card]")).toBeNull();
});

test("the client keeps well-formed secret requests and drops the rest", async () => {
  const base = { id: "s1", kind: "secret", state: "pending", askedAt: "2026-11-22T00:00:00.000Z", expiresAt: "2026-11-23T00:00:00.000Z", name: "OPENAI_API_KEY", sites: ["api.openai.com"], service: "OpenAI", outside: false, approveUrl: "https://openkey.so/a" };
  const api = createBotsApi({
    baseUrl: "https://backend.test/", getToken: () => "t",
    fetch: async () => Response.json({ requests: [
      base,
      { ...base, id: "s2", name: "lower_case" },
      { ...base, id: "s3", sites: [] },
      { ...base, id: "s4", sites: ["https://api.openai.com/x"] },
      { ...base, id: "s5", state: "granted" },
      { ...base, id: "s6", approveUrl: "javascript:alert(1)" },
    ] }),
  });
  const list = await api.listRequests();
  expect(list.map((request) => request.id)).toEqual(["s1", "s6"]);
  expect(list[0]).toMatchObject({ kind: "secret", name: "OPENAI_API_KEY", approveUrl: "https://openkey.so/a" });
  expect(list[1]).not.toHaveProperty("approveUrl");
});
