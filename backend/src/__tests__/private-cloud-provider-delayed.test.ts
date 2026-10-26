// `provider_delayed` on a PTX job (TC-2085): relayed as exactly `true` while the job is open;
// an absent, false or malformed field (a PTX that predates it) leaves the response unchanged.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

// No test here writes under a home directory; pin it to a ticket-named temp dir anyway and assert it.
const HOME = mkdtempSync(join("/var/tmp", "tc-2085."));
appendFileSync("/var/tmp/tc-2085-mktemp-list.txt", `${HOME}\n`);
process.env.HOME = HOME;
if (process.env.HOME !== HOME || !HOME.startsWith("/var/tmp/tc-2085.")) throw new Error("test HOME is not the ticket temp dir");
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

import { parseJob, parseJobList } from "../services/private-cloud-transcription-dto.js";

const ID = "trn_0123456789ABCDEFGHJKMNPQRS";

function ptxJob(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    status,
    byte_size: 1000,
    channel_mode: "mixed",
    channel_labels: ["Exo voice note"],
    duration_seconds: 12,
    channels: 1,
    progress: status === "processing" ? { stage: "transcribing", queue_position: null, regions_completed: 0, regions_total: 2 } : null,
    retention: { audio: "stored", audio_deleted_at: null, transcript_expires_at: null },
    error: status === "failed" ? { code: "provider_unavailable" } : null,
    created_at: "2026-10-26T12:00:00.000Z",
    ...extra,
  };
}

describe("provider_delayed relay", () => {
  test("an open job that PTX holds for its provider reports provider_delayed: true", () => {
    for (const status of ["awaiting_upload", "queued", "processing"]) {
      expect(parseJob(ptxJob(status, { provider_delayed: true }), ID)).toMatchObject({ status, provider_delayed: true });
    }
  });

  test("an absent field leaves the job exactly as it was: no provider_delayed key", () => {
    const parsed = parseJob(ptxJob("processing"), ID);
    expect(parsed).not.toBeNull();
    expect("provider_delayed" in parsed!).toBe(false);
  });

  test("false, and anything that is not the boolean true, is not delayed", () => {
    for (const value of [false, null, "true", 1, {}]) {
      const parsed = parseJob(ptxJob("queued", { provider_delayed: value }), ID);
      expect(parsed).not.toBeNull();
      expect("provider_delayed" in parsed!).toBe(false);
    }
  });

  test("a finished job is never reported as delayed", () => {
    for (const status of ["completed", "failed", "cancelled"]) {
      const error = status === "failed" ? { code: "provider_unavailable" } : status === "cancelled" ? { code: "cancelled" } : null;
      const parsed = parseJob(ptxJob(status, { provider_delayed: true, error }), ID);
      expect(parsed).not.toBeNull();
      expect("provider_delayed" in parsed!).toBe(false);
    }
  });

  test("the list relays it per job", () => {
    const list = parseJobList({ data: [ptxJob("queued", { provider_delayed: true })] }, 5);
    expect(list?.transcriptions[0]).toMatchObject({ provider_delayed: true });
  });
});
