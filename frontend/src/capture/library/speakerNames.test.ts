import { expect, test } from "bun:test";
import { applySpeakerNames, readSpeakerNames, speakerDisplayName, withSpeakerName } from "./speakerNames";
import { transcriptMarkdown, transcriptWithTimestamps } from "./transcriptSegments";
import { transcriptCopyText } from "@/lib/connectors/meetingExplorer";

const sentences = [
  { index: 0, speaker_name: "Me", text: "Hello.", start_time: 0, end_time: 2 },
  { index: 1, speaker_name: "Them", text: "Let's begin.", start_time: 42, end_time: 45 },
  { index: 2, speaker_name: "Me", text: "Done.", start_time: 50, end_time: 52 },
];

test("a rename shows on every line of that speaker and leaves the stored sentences alone", () => {
  const names = withSpeakerName({}, "Me", "Sam");
  const shown = applySpeakerNames(sentences, names);
  expect(shown.map((s) => s.speaker_name)).toEqual(["Sam", "Them", "Sam"]);
  expect(sentences.map((s) => s.speaker_name)).toEqual(["Me", "Them", "Me"]);
});

test("the other side takes one name or a list", () => {
  const names = withSpeakerName(withSpeakerName({}, "Me", "Sam"), "Them", "  Alice,   Bob ");
  expect(names).toEqual({ Me: "Sam", Them: "Alice, Bob" });
  expect(speakerDisplayName(names, "Them")).toBe("Alice, Bob");
});

test("renaming back to the original label, or to nothing, clears the override", () => {
  const renamed = withSpeakerName({}, "Speaker A", "Ana");
  expect(withSpeakerName(renamed, "Speaker A", "Speaker A")).toEqual({});
  expect(withSpeakerName(renamed, "Speaker A", "   ")).toEqual({});
  expect(withSpeakerName({ ...renamed, "Speaker B": "Ben" }, "Speaker A", "")).toEqual({ "Speaker B": "Ben" });
});

test("the override is keyed by the original label, so a new transcript with the same labels keeps it", () => {
  const names = readSpeakerNames({ speaker_names: { Me: "Sam" }, transcript_provider: "assemblyai" });
  const retranscribed = [{ index: 0, speaker_name: "Me", text: "Different words.", start_time: 0, end_time: 3 }];
  expect(applySpeakerNames(retranscribed, names)[0]!.speaker_name).toBe("Sam");
});

test("copy, copy with timestamps and Markdown use the names", () => {
  const shown = applySpeakerNames(sentences, { Me: "Sam", Them: "Alice, Bob" });
  expect(transcriptCopyText(shown)).toContain("Alice, Bob: Let's begin.");
  expect(transcriptWithTimestamps(shown)).toBe("[00:00] Sam: Hello.\n[00:42] Alice, Bob: Let's begin.\n[00:50] Sam: Done.");
  expect(transcriptMarkdown("Call", null, shown)).toContain("[00:42] Alice, Bob: Let's begin.");
});

test("stored metadata that is not a name map is ignored", () => {
  expect(readSpeakerNames(null)).toEqual({});
  expect(readSpeakerNames({ speaker_names: ["Sam"] })).toEqual({});
  expect(readSpeakerNames({ speaker_names: { Me: 3, Them: "", You: "You", "Speaker A": "Ana" } })).toEqual({ "Speaker A": "Ana" });
});
