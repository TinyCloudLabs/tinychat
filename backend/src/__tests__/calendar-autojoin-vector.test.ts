import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");

test.skipIf(!process.env.VECTOR_BIN)("Vector ships closed calendar events and discards hostile extra fields", async () => {
  const scratch = mkdtempSync("/var/tmp/tc4406-vector-");
  try {
    const shipped = loadYaml(await Bun.file(join(root, "log-shipper/vector.yaml")).text()) as {
      transforms: Record<string, { inputs: string[] }>;
      sinks: { betterstack: { inputs: string[] } };
    };
    shipped.transforms.redact.inputs = ["stdin"];
    const config = { sources: { stdin: { type: "stdin", decoding: { codec: "json" } } },
      transforms: shipped.transforms,
      sinks: { out: { type: "console", inputs: shipped.sinks.betterstack.inputs, encoding: { codec: "json" } } } };
    const path = join(scratch, "vector.json");
    writeFileSync(path, JSON.stringify(config));
    const events = [
      { event: "calendar_autojoin_tick", tenants: 2, rows: 4, scans: 1, timers_due: 3, scan_complete: false, duration_ms: 12 },
      { event: "calendar_autojoin_decision", reason: "not_accepted", start: "2026-11-25T12:00:00.000Z", tenant_hash: "aabbccddeeff" },
      { event: "calendar_autojoin_connection", state: "needs_reconnect", code: "needs_reconnect", tenant_hash: "aabbccddeeff" },
    ];
    const input = events.map(event => JSON.stringify({ "_tc.logship": "tinychat-backend", level: 6,
      message: JSON.stringify({ ...event, title: "GOOGLE_CANARY_private_title", email: "private@example.test" }) })).join("\n") + "\n";
    const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
      env: { PATH: process.env.PATH ?? "", HOME: scratch, TC_HOME: scratch, VECTOR_LOG: "error" },
      stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited, err).toBe(0);
    const rows = out.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows.filter(row => String(row.event).startsWith("calendar_autojoin_")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "calendar_autojoin_tick", scans: 1, scan_complete: false }),
        expect.objectContaining({ event: "calendar_autojoin_decision", reason: "not_accepted", tenant_hash: "aabbccddeeff" }),
        expect.objectContaining({ event: "calendar_autojoin_connection", state: "needs_reconnect", code: "needs_reconnect" }),
      ]));
    for (const row of rows) {
      expect(row).not.toHaveProperty("title");
      expect(row).not.toHaveProperty("email");
    }
    expect(JSON.stringify(rows)).not.toContain("GOOGLE_CANARY");
    expect(JSON.stringify(rows)).not.toContain("private@example.test");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
