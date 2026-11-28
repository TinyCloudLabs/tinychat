import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { configureRequestLogAccountHash } from "../request-context.js";
import { calendarDecisionEvent } from "../services/calendar-autojoin-log-events.js";
import { MEETING_FAILURE_CODES, meetingFailureCode } from "../services/transcription-api.js";

const root = resolve(import.meta.dir, "../../..");
const START = Date.parse("2026-11-27T14:30:00.000Z");

afterEach(() => configureRequestLogAccountHash(undefined));

describe("TC-4461 failed-meeting reason", () => {
  test("only the service's listed codes are kept; anything else is other", () => {
    for (const code of MEETING_FAILURE_CODES) expect(meetingFailureCode({ code })).toBe(code);
    for (const code of ["meeting_already_captured", "unauthorized", "Meeting_Join_Failed", "", "free text with spaces"]) {
      expect(meetingFailureCode({ code })).toBe("other");
    }
    expect(meetingFailureCode(undefined)).toBe("other");
    expect(meetingFailureCode(null)).toBe("other");
  });

  test("a failed decision carries the closed code and no meeting id", () => {
    configureRequestLogAccountHash("k".repeat(32));
    const event = calendarDecisionEvent({ tenant: "0xabc", start: START, meetingId: "mtg_secret_id_123", failureCode: "bot_removed" } as Parameters<typeof calendarDecisionEvent>[0], "failed");
    expect(event).toMatchObject({ reason: "failed", code: "bot_removed" });
    expect(JSON.stringify(event)).not.toContain("mtg_secret_id_123");
    expect(JSON.stringify(event)).not.toContain("0xabc");
  });

  test("the code is only on failed decisions; invitations carry none", () => {
    const row = { tenant: "0xabc", start: START, failureCode: "bot_removed" as const };
    expect(calendarDecisionEvent(row, "completed")).not.toHaveProperty("code");
    expect(calendarDecisionEvent(row, "sent")).not.toHaveProperty("code");
    expect(calendarDecisionEvent({ tenant: "0xabc", start: START }, "failed")).not.toHaveProperty("code");
    for (const reason of ["not_accepted", "event_ineligible"] as const) {
      expect(calendarDecisionEvent(row, reason)).not.toHaveProperty("code");
    }
  });

  test.skipIf(!process.env.VECTOR_BIN)("Vector ships the closed code and drops anything outside the list", async () => {
    const scratch = mkdtempSync("/var/tmp/tc4461-vector-");
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
      const base = { event: "calendar_autojoin_decision", start: "2026-11-27T14:30:00.000Z", tenant_hash: "aabbccddeeff" };
      const events = [
        { ...base, reason: "failed", code: "bot_removed" },
        { ...base, reason: "failed", code: "PRIVATE_CODE_CANARY" },
        { ...base, reason: "sent", code: "bot_removed" },
        { ...base, reason: "not_accepted", invite_hash: "112233445566", code: "bot_removed" },
      ];
      const input = events.map(event => JSON.stringify({ "_tc.logship": "tinychat-backend", level: 6,
        message: JSON.stringify({ ...event, message: "PRIVATE_MESSAGE_CANARY", meeting_hash: "0123456789ab", meeting_id: "mtg_PRIVATE" }) })).join("\n") + "\n";
      const proc = Bun.spawn([process.env.VECTOR_BIN!, "--quiet", "--config", path], {
        env: { PATH: process.env.PATH ?? "", HOME: scratch, TC_HOME: scratch, VECTOR_LOG: "error" },
        stdin: new Blob([input]), stdout: "pipe", stderr: "pipe", timeout: 60_000,
      });
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      expect(await proc.exited, err).toBe(0);
      const rows = out.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(row => row.event === "calendar_autojoin_decision");
      expect(rows).toHaveLength(4);
      // Separate lanes can reorder events, so rows are found by content.
      const failed = rows.find(row => row.reason === "failed" && row.code === "bot_removed");
      const hostile = rows.find(row => row.reason === "failed" && row.code !== "bot_removed")!;
      const sent = rows.find(row => row.reason === "sent")!;
      const invite = rows.find(row => row.reason === "not_accepted")!;
      expect(failed).toMatchObject({ reason: "failed", code: "bot_removed" });
      expect(hostile).toMatchObject({ reason: "failed" });
      expect(hostile).not.toHaveProperty("code");
      expect(sent).toMatchObject({ reason: "sent" });
      expect(sent).not.toHaveProperty("code");
      expect(invite).toMatchObject({ reason: "not_accepted", invite_hash: "112233445566" });
      expect(invite).not.toHaveProperty("code");
      for (const row of rows) {
        expect(row).not.toHaveProperty("meeting_hash");
        expect(row).not.toHaveProperty("meeting_id");
        expect(row).not.toHaveProperty("message");
      }
      expect(out).not.toContain("CANARY");
      expect(out).not.toContain("mtg_PRIVATE");
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 120_000);
});
