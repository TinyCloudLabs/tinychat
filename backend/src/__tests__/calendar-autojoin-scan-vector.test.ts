import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");

test.skipIf(!process.env.VECTOR_BIN)("Vector ships aggregate scan counters without tenant identity", async () => {
  const scratch = mkdtempSync("/var/tmp/tc4406-scan-vector-");
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
    const event = { event: "calendar_autojoin_scan", tenant_hash: "aabbccddeeff", listed: 4, eligible: 1,
      skipped_not_confirmed: 1, skipped_not_timed: 1, skipped_no_meet_link: 0,
      skipped_not_accepted: 0, skipped_other: 1, scan_complete: true };
    const input = [event, { ...event, listed: -1 }].map(row => JSON.stringify({ "_tc.logship": "tinychat-backend", level: 6,
      message: JSON.stringify({ ...row, title: "GOOGLE_CANARY_private_title", event_id: "private-event-id", attendee: "private@example.test" }) })).join("\n") + "\n";
    const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
      env: { PATH: process.env.PATH ?? "", HOME: scratch, TC_HOME: scratch, VECTOR_LOG: "error" },
      stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited, err).toBe(0);
    const rows = out.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    expect(rows.filter(row => row.event === "calendar_autojoin_scan")).toEqual([{
      svc: "backend", event: "calendar_autojoin_scan", component: "calendar-autojoin", level: "info", ts: expect.any(String),
      listed: 4, eligible: 1, skipped_not_confirmed: 1, skipped_not_timed: 1,
      skipped_no_meet_link: 0, skipped_not_accepted: 0, skipped_other: 1, scan_complete: true,
    }]);
    expect(JSON.stringify(rows)).not.toContain("GOOGLE_CANARY");
    expect(JSON.stringify(rows)).not.toContain("private-event-id");
    expect(JSON.stringify(rows)).not.toContain("private@example.test");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 120_000);
