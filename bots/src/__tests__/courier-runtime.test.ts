import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../config";
import { startCourierGateway } from "../courier/runtime";
import { Gateway } from "../gateway";
import { MeetingDesk } from "../meeting-reads";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "courier-runtime-")); dirs.push(dir);
  const cfg: GatewayConfig = { egressRoot: "/unused", modelKey: "fixture", upstream: "https://model.test", models: ["m"], maxTokens: 100, botDailyTokens: 100, globalDailyTokens: 1000, maxBodyBytes: 4096, maxResponseBytes: 4096, connectTimeoutMs: 1000, totalTimeoutMs: 5000, bodyTimeoutMs: 1000, budgetFile: join(dir, "budget.json") };
  const gateway = new Gateway(cfg, { fetch: async () => Response.json({}) });
  const reads = new MeetingDesk({ backendOrigin: "https://backend.test", backendCallSecret: "s".repeat(48), fetch: async () => Response.json({ ok: true, text: "unused" }) });
  const start = () => startCourierGateway({ cfg, gateway, reads, env: { BOTS_TEST_ACCOUNTS: `0x${"ab".repeat(20)}` }, sealKey: async () => new Uint8Array(32).fill(7) });
  return { dir, start };
}

test("stop releases the peer store lock; a second gateway on one state dir needs the first stopped", async () => {
  const s = setup();
  const first = await s.start();
  await expect(s.start()).rejects.toThrow("courier_state_locked");
  first.stop();
  const second = await s.start();
  second.stop();
  second.stop();
});

test("a start that fails after the peer store opened releases its lock", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "courier-intake"), { recursive: true });
  writeFileSync(join(s.dir, "courier-intake", "damaged.json"), "not a sealed record");
  await expect(s.start()).rejects.toThrow("courier_state_invalid");
  rmSync(join(s.dir, "courier-intake", "damaged.json"));
  (await s.start()).stop();
});
