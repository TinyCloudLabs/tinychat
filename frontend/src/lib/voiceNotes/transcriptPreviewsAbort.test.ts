import { expect, test } from "bun:test";
import { readTranscriptPreviews, TranscriptPreviewsAbortedError } from "./voiceNoteCommits";

// TC-4462: signing out aborts the Library's preview read; that is expected, not an error to log.
type Answer = { ok: true; data: { rows: unknown[][] } } | { ok: false; error: { code: string; message: string } };
const tcwAnswering = (...answers: Answer[]) => {
  const queue = [...answers];
  return { sql: { db: () => ({ query: async () => queue.shift() as Answer }) } } as unknown as Parameters<typeof readTranscriptPreviews>[0];
};
const tableFound: Answer = { ok: true, data: { rows: [[1]] } };

test("a preview read cut off by the session ending is a named abort, not a generic failure", async () => {
  const tcw = tcwAnswering(tableFound, { ok: false, error: { code: "ABORTED", message: "Request was aborted." } });
  await expect(readTranscriptPreviews(tcw)).rejects.toBeInstanceOf(TranscriptPreviewsAbortedError);
});

test("any other failed preview read still throws a plain error with its message", async () => {
  const tcw = tcwAnswering(tableFound, { ok: false, error: { code: "INTERNAL", message: "disk gone" } });
  const caught = await readTranscriptPreviews(tcw).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(TranscriptPreviewsAbortedError);
  expect((caught as Error).message).toBe("Read transcript previews: disk gone");
});

test("answered previews are returned by recording id", async () => {
  const tcw = tcwAnswering(tableFound, { ok: true, data: { rows: [["rec-1", "hello there"], ["rec-2", 5]] } });
  expect([...await readTranscriptPreviews(tcw)]).toEqual([["rec-1", "hello there"]]);
});
