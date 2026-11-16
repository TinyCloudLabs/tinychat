import { describe, expect, test } from "bun:test";
import { supervisorConfig } from "../config";

const env = (extra: Record<string, string> = {}) => ({ BOTS_SERVICE_SECRET: "s".repeat(64), ...extra });

describe("supervisor memory budget", () => {
  test("defaults: state fits inside the sandbox limit, and three bots fit the total with their restored state", () => {
    const cfg = supervisorConfig(env());
    expect(cfg.limits).toMatchObject({ memoryMb: 1536, overlayMb: 512, tmpMb: 256, stateMb: 256 });
    expect(cfg.totalMemoryMb).toBe(6144);
    expect(cfg.maxRunning).toBe(3);
  });

  test("the sandbox limit must hold the root layer, /tmp and state plus 512 MiB", () => {
    expect(() => supervisorConfig(env({ BOTS_STATE_MB: "257" }))).toThrow("BOTS_SANDBOX_MEMORY_MB");
    expect(supervisorConfig(env({ BOTS_STATE_MB: "512", BOTS_SANDBOX_MEMORY_MB: "1792" })).limits.stateMb).toBe(512);
  });

  test("BOTS_MAX_RUNNING follows the total by default and may not overcommit it", () => {
    expect(supervisorConfig(env({ BOTS_TOTAL_MEMORY_MB: "8192" })).maxRunning).toBe(4);
    expect(supervisorConfig(env({ BOTS_MAX_RUNNING: "2" })).maxRunning).toBe(2);
    expect(() => supervisorConfig(env({ BOTS_MAX_RUNNING: "4" }))).toThrow("BOTS_MAX_RUNNING");
    expect(() => supervisorConfig(env({ BOTS_TOTAL_MEMORY_MB: "1536" }))).toThrow("BOTS_TOTAL_MEMORY_MB");
  });
});
