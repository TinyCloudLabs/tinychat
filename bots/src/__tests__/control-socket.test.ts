import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMISSION_CONTROL_PATH } from "../bot-admission";
import { SIGNED_SCHEME } from "../signed-call";

const GATEWAY_MAIN = join(import.meta.dir, "..", "gateway-main.ts");
const BOT = "e".repeat(64);

/** The real gateway process on a scratch egress root: only its control socket is used, no model or network. */
describe("the gateway's control socket", () => {
  const dir = mkdtempSync(join(tmpdir(), "control-socket-"));
  const socket = join(dir, "control.sock");
  let gateway: ReturnType<typeof Bun.spawn> | undefined;

  beforeAll(async () => {
    gateway = Bun.spawn([process.execPath, GATEWAY_MAIN], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        REDPILL_API_KEY: "test-only",
        BOTS_EGRESS_ROOT: dir,
        BOTS_BUDGET_FILE: join(dir, "state", "budget.json"),
        BOTS_BACKEND_CALL_SECRET: "c".repeat(64),
      },
      stdout: "pipe",
      stderr: "ignore",
    });
    // The gateway logs `listening` once the control socket is up.
    const reader = (gateway.stdout as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let output = "";
    while (!output.includes(`"gateway":"listening"`)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`gateway exited before listening: ${output}`);
      output += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    expect(existsSync(socket)).toBe(true);
  });

  afterAll(async () => {
    gateway?.kill();
    await gateway?.exited;
    rmSync(dir, { recursive: true, force: true });
  });

  const control = (path: string, method: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`http://localhost${path}`, { unix: socket, method, body, headers: { "content-type": "application/json", ...headers } });

  test("takes an actions push of about 1 KB, over the admission relay's 512 bytes", async () => {
    const push = JSON.stringify({ pending: 0, day: "2026-03-02", today: 0, final: Array.from({ length: 15 }, (_, n) => n.toString(16).padStart(64, "0")) });
    expect(push.length).toBeGreaterThan(1000);
    expect((await control(`/bots/${BOT}/actions`, "PUT", push)).status).toBe(204);
  });

  test("the admission relay keeps its own 512 byte cap", async () => {
    const body = JSON.stringify({ pad: "x".repeat(1000) });
    expect((await control(ADMISSION_CONTROL_PATH, "POST", body, { authorization: `${SIGNED_SCHEME}x` })).status).toBe(413);
  });
});
