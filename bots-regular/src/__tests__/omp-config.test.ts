import { afterEach, expect, test } from "bun:test";
import { configYml } from "../../../bots/src/sandbox";
import { type Runtime, send, startRuntime } from "./harness";

const OWNER = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const SIBLING_KEY = "0123456789abcdef0123456789abcdef";

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

test("OMP in a regular bot's sandbox runs with the same config.yml as in bots/, skills and extra tools off", async () => {
  runtime = startRuntime(60_000);
  for (const bot of [runtime.bots.forOwner(OWNER), runtime.bots.forBot(OWNER, SIBLING_KEY)]) {
    const reply = (await send(bot, "probe config")).text;
    expect(reply).toStartWith("config: ");
    const written = Buffer.from(reply.slice("config: ".length), "base64").toString("utf8");
    expect(written).toBe(configYml());
    expect(written).toContain("skills:\n  enabled: false");
  }
}, 60_000);
