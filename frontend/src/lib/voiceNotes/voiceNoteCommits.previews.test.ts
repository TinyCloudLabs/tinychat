// The committed transcripts' previews in one read, what a Library row is titled by (P1-8).
import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { readTranscriptPreviews } from "./voiceNoteCommits";

function space(answers: { table: boolean; previews?: unknown[][]; fail?: string }) {
  const asked: string[] = [];
  const tcw = { sql: { db: () => ({ query: async (sql: string) => {
    asked.push(sql);
    if (sql.includes("sqlite_schema")) return { ok: true, data: { rows: answers.table ? [[1]] : [] } };
    return answers.fail ? { ok: false, error: { message: answers.fail } } : { ok: true, data: { rows: answers.previews ?? [] } };
  } }) } } as unknown as TinyCloudWeb;
  return { tcw, asked };
}

describe("readTranscriptPreviews", () => {
  test("is empty, with no further read, for a space without the transcript table", async () => {
    const { tcw, asked } = space({ table: false });
    expect((await readTranscriptPreviews(tcw)).size).toBe(0);
    expect(asked).toHaveLength(1);
  });

  test("maps each recording to its preview, asking only for transcribed ones that have text", async () => {
    const { tcw, asked } = space({ table: true, previews: [["rec-1", "Hello there"], ["rec-2", "Second"]] });
    const previews = await readTranscriptPreviews(tcw);
    expect([...previews]).toEqual([["rec-1", "Hello there"], ["rec-2", "Second"]]);
    expect(asked[1]).toContain("outcome = 'transcribed'");
    expect(asked[1]).toContain("preview IS NOT NULL");
  });

  test("a failed read throws, never an empty answer", async () => {
    const { tcw } = space({ table: true, fail: "db is locked" });
    await expect(readTranscriptPreviews(tcw)).rejects.toThrow("Read transcript previews: db is locked");
  });
});
