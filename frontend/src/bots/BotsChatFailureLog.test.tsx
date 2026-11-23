// What the console keeps when a bot's earlier messages do not load: known names, codes and messages only.
import { afterEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { MAIN_BOT } from "./BotAvatar";
import type { BotChatApi } from "./botChatApi";
import { BotsError } from "./botsApi";
import { BotsChat, type BotsController } from "./BotsChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const RESEARCH = "0123456789abcdef0123456789abcdef";
const SECRETS = "https://node.example/x?sig=SECRET123 Bearer TOKEN456";
/** A failure with a signed address and a token in its message, name, code and stack, and in the failure inside it. */
const seeded = (message: string, inner = true): Error => {
  const error = new Error(message, inner ? { cause: seeded(`inner ${SECRETS}`, false) } : undefined);
  return Object.assign(error, { name: SECRETS, code: SECRETS, stack: `${SECRETS}\n    at ${SECRETS}` });
};

/** Every argument the console was given while the earlier messages failed to load, as text. */
async function loggedWhenListingFails(failure: unknown): Promise<string> {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    restore = installDom();
    const api: BotChatApi = {
      listMessages: async () => { throw failure; },
      send: async () => {},
      readNotice: async () => null,
      acknowledgeNotice: async (_key, notice) => notice,
    };
    const controller: BotsController = { status: "ready", roster: { bots: [{ key: RESEARCH, name: "Research", environment: "private", state: "active" }] } };
    const host = document.createElement("div");
    document.body.append(host);
    mounted = createRoot(host);
    await act(async () => mounted!.render(
      <BotsChat controller={controller} selected={RESEARCH} faceOf={(b) => ({ ...MAIN_BOT, name: b.name })} history={null} active chatApi={api} />,
    ));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    return warn.mock.calls.map((call) => call.map((argument) => JSON.stringify(argument) ?? "").join(" ")).join("\n");
  } finally {
    warn.mockRestore();
  }
}

const expectNoSecrets = (logged: string) => {
  expect(logged).not.toContain("SECRET123");
  expect(logged).not.toContain("TOKEN456");
};

test("the console keeps no text, name, code or stack of a failure that stopped a bot's earlier messages, or of the failure inside it", async () => {
  const logged = await loggedWhenListingFails(seeded(`request to ${SECRETS} failed`));
  expect(logged).toContain("did not load");
  expect(logged).toContain('"name":"unknown"');
  expectNoSecrets(logged);
});

test("the console keeps no text, name, code or stack of a failure inside a bots error", async () => {
  const logged = await loggedWhenListingFails(new BotsError("failed", { cause: seeded(`request to ${SECRETS} failed`) }));
  expect(logged).toContain("did not load");
  expect(logged).toContain("Bots request failed: failed");
  expectNoSecrets(logged);
});

test("the console keeps a known history code and nothing else of the failure", async () => {
  const logged = await loggedWhenListingFails(seeded("history_session_expired"));
  expect(logged).toContain("history_session_expired");
  expectNoSecrets(logged);
});
