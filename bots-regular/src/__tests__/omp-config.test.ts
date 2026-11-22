import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configYml } from "../../../bots/src/sandbox";
import { FAKE_AGENT, type Runtime, send, startRuntime } from "./harness";

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

test("the bridge refuses an arm without OMP's config, so OMP never starts without it", async () => {
  const home = mkdtempSync(join(tmpdir(), "bridge-config-"));
  const bridge = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "sandbox", "bridge.ts"), ...FAKE_AGENT], {
    env: { PATH: process.env.PATH, HOME: home, BRIDGE_HOST: "127.0.0.1", BRIDGE_PORT: "0", ARM_PORT: "0" },
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    const reader = bridge.stdout.getReader();
    let text = "";
    while (!text.includes('"listening"')) text += new TextDecoder().decode((await reader.read()).value);
    const { arm } = JSON.parse(text.split("\n").find(line => line.includes('"listening"'))!) as { arm: number };
    const body = {
      bridgeToken: "a".repeat(64), gatewayToken: "b".repeat(64), gatewayUrl: `http://127.0.0.1:1/bots/${"c".repeat(64)}/v1`, model: "m",
    };
    const post = (payload: object) => fetch(`http://127.0.0.1:${arm}/arm`, { method: "POST", body: JSON.stringify(payload) });
    expect((await post(body)).status).toBe(400);
    expect((await post({ ...body, ompConfig: "" })).status).toBe(400);
    expect((await post({ ...body, ompConfig: configYml() })).status).toBe(204);
  } finally {
    bridge.kill("SIGKILL");
    await bridge.exited;
    rmSync(home, { recursive: true, force: true });
  }
});
