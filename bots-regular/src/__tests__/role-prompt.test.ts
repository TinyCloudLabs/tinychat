import { afterEach, expect, test } from "bun:test";
import { type Runtime, send, startRuntime } from "./harness";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const SIBLING_KEY = "0123456789abcdef0123456789abcdef";

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

test("Main starts with Main's system prompt and a sibling with the sibling's", async () => {
  runtime = startRuntime(60_000);
  const main = runtime.bots.forOwner(OWNER);
  const sibling = runtime.bots.forBot(OWNER, SIBLING_KEY);

  expect((await send(main, "probe prompt")).text).toStartWith("system prompt: You are Main, the owner's main bot");
  expect((await send(sibling, "probe prompt")).text).toStartWith("system prompt: You are one of the owner's bots");
}, 60_000);
