// A transcript names its backup-transcriber lines once, above the text: never per line,
// and never for lines recovered from the recording.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import type { LibraryItem } from "./LibraryRow";
import { NoteDetailView } from "./NoteDetailView";
import { TimestampedTranscript } from "./TimestampedTranscript";
import { TRANSCRIPT_FALLBACK_NOTE } from "./transcriptProvenanceCopy";

const noop = () => {};
const MEETING: LibraryItem = { id: "row-2", source: "tinycloud-transcriber", sourceId: "mtg-2", title: "Weekly sync", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 1880 };
const VOICE: LibraryItem = { id: "row-1", source: "exo-voice-note", sourceId: "rec-1", title: "Voice note", startedAt: "2026-10-06T09:28:00.000Z", durationSecs: 42 };
const MERGED: LibraryItem = { id: "row-m", source: "exo-merged", sourceId: "merged-1", title: "Planning", startedAt: "2026-10-05T14:00:00.000Z", durationSecs: 3600 };

const line = (index: number, source?: FirefliesSentence["source"]): FirefliesSentence =>
  ({ index, speaker_name: "Ana", text: `Line number ${index}.`, start_time: index * 8, end_time: index * 8 + 7, ...(source ? { source } : {}) });

function render(sentences: FirefliesSentence[], item: LibraryItem = MEETING) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NoteDetailView item={item} listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "ok", sentences }}
        audio={{ load: async () => null }} copyState="idle" onCopy={noop} onRetry={noop} pushed onBack={noop} />
    </MemoryRouter>,
  );
}
const noteCount = (html: string) => html.split(TRANSCRIPT_FALLBACK_NOTE).length - 1;

test("a transcript with backup-transcriber lines shows the note once, above the first line", () => {
  const html = render([line(0, "recording"), line(1, "fallback"), line(2, "fallback"), line(3, "recording"), line(4)]);
  expect(noteCount(html)).toBe(1);
  expect(html.indexOf(TRANSCRIPT_FALLBACK_NOTE)).toBeLessThan(html.indexOf("Line number 0."));
});

test("a mixed transcript shows the backup note and nothing about recovered lines", () => {
  const html = render([line(0, "recording"), line(1, "fallback")]);
  expect(noteCount(html)).toBe(1);
  expect(html.toLowerCase()).not.toContain("recovered");
});

test("no row carries a per-line provenance tag", () => {
  const html = render([line(0, "fallback"), line(1, "recording"), line(2, "fallback")]);
  expect(html).not.toContain("Fallback transcript");
  expect(html).not.toContain("Recovered from recording");
  const rows = renderToStaticMarkup(<TimestampedTranscript sentences={[line(0, "fallback"), line(1, "recording")]} hasAudio />);
  expect(rows).not.toContain("backup");
  expect(rows).not.toContain("recover");
  expect(rows).not.toContain("allback");
});

test("lines recovered from the recording alone show no note", () => {
  const html = render([line(0, "recording"), line(1, "recording"), line(2)]);
  expect(html).not.toContain('data-testid="transcript-provenance-note"');
  expect(html).toContain("Line number 1.");
});

test("a transcript without provenance, and a voice note, show no note", () => {
  expect(render([line(0), line(1)])).not.toContain('data-testid="transcript-provenance-note"');
  expect(render([line(0), line(1)], VOICE)).not.toContain('data-testid="transcript-provenance-note"');
});

test("a combined note applies the same rule to its merged lines", () => {
  expect(noteCount(render([line(0), line(1, "fallback"), line(2, "recording")], MERGED))).toBe(1);
  expect(render([line(0, "recording"), line(1)], MERGED)).not.toContain('data-testid="transcript-provenance-note"');
});

test("an untimed transcript with backup lines still names them once", () => {
  const untimed = [0, 1].map((index): FirefliesSentence => ({ index, speaker_name: "Ana", text: `Plain ${index}.`, start_time: 0, end_time: 0, source: "fallback" }));
  const html = render(untimed);
  expect(noteCount(html)).toBe(1);
  expect(html).toContain("Plain 1.");
});
