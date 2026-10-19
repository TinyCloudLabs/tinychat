import { describe, expect, test } from "bun:test";

import type { GmeetSyncDiagnostics, GmeetSyncProgress, GmeetSyncResult } from "./gmeetSync";
import {
  createGmeetSyncLogRecorder,
  GMEET_SYNC_LOG_MAX_ENTRIES,
  type GmeetSyncLog,
  gmeetSyncProgressPercent,
  summarizeGmeetSyncResult,
} from "./gmeetSyncLog";

const TOKEN = "ya29.a0-SECRET-access-token-value";
const TITLE = "Quarterly Planning with Alice Anderson";
const TRANSCRIPT = "Alice said the launch date is confidential";

const progress = (patch: Partial<GmeetSyncProgress>): GmeetSyncProgress => ({
  type: "progress", current: 0, total: null, synced: 0, failed: 0, skipped: 0, ...patch,
});

describe("gmeetSyncProgressPercent", () => {
  test("is 0 before any event and while the meeting total is unknown", () => {
    expect(gmeetSyncProgressPercent(null)).toBe(0);
    expect(gmeetSyncProgressPercent(progress({ type: "status", message: "listing" }))).toBe(0);
  });

  test("walks meetings 0-40, listing 45, notes 50-90, saving 95 and complete 100", () => {
    const values = [
      progress({ current: 0, total: 4, stage: "meetings" }),
      progress({ current: 2, total: 4, stage: "meetings" }),
      progress({ current: 4, total: 4, stage: "meetings" }),
      progress({ current: 4, total: 4, stage: "notes-listing" }),
      progress({ current: 4, total: 4, stage: "notes", notesDone: 0, notesTotal: 10 }),
      progress({ current: 4, total: 4, stage: "notes", notesDone: 5, notesTotal: 10 }),
      progress({ current: 4, total: 4, stage: "notes", notesDone: 10, notesTotal: 10 }),
      progress({ current: 4, total: 4, stage: "saving" }),
      progress({ type: "complete", current: 4, total: 4, stage: "saving" }),
    ].map(gmeetSyncProgressPercent);
    expect(values).toEqual([0, 20, 40, 45, 50, 70, 90, 95, 100]);
  });

  test("treats zero meetings as the meetings stage finished and clamps bad counts", () => {
    expect(gmeetSyncProgressPercent(progress({ current: 0, total: 0, stage: "meetings" }))).toBe(40);
    expect(gmeetSyncProgressPercent(progress({ current: 9, total: 4 }))).toBe(40);
    expect(gmeetSyncProgressPercent(progress({ stage: "notes", notesDone: 3, notesTotal: 0 }))).toBe(50);
    expect(gmeetSyncProgressPercent(progress({ stage: "notes", notesDone: 99, notesTotal: 10 }))).toBe(90);
  });
});

describe("createGmeetSyncLogRecorder", () => {
  test("records a stage timeline with counters and elapsed time, collapsing repeats", () => {
    let clock = 1_000;
    const recorder = createGmeetSyncLogRecorder(() => clock);
    recorder.record(progress({ current: 1, total: 2 }));
    clock += 250;
    recorder.record(progress({ current: 1, total: 2 })); // identical: not a new row
    recorder.record(progress({ current: 2, total: 2, stage: "notes", notesDone: 1, notesTotal: 3, docsListed: 200, docsMatched: 3 }));
    const log = recorder.build({ generatedAt: new Date("2026-10-19T12:00:00Z"), build: "Exo 0.9.0 · web" });
    expect(log.generatedAt).toBe("2026-10-19T12:00:00.000Z");
    expect(log.build).toBe("Exo 0.9.0 · web");
    expect(log.timeline).toEqual([
      { tMs: 0, stage: "meetings", meetingsChecked: 1, meetingsTotal: 2, notesDone: null, notesTotal: null, docsListed: null, docsMatched: null },
      { tMs: 250, stage: "notes", meetingsChecked: 2, meetingsTotal: 2, notesDone: 1, notesTotal: 3, docsListed: 200, docsMatched: 3 },
    ]);
    expect(log.result).toBeNull();
    expect(log.diagnostics).toBeNull();
  });

  test("caps the timeline, keeping the start and the latest rows", () => {
    const recorder = createGmeetSyncLogRecorder(() => 0);
    for (let i = 0; i < GMEET_SYNC_LOG_MAX_ENTRIES + 50; i++) recorder.record(progress({ current: i, total: 1000 }));
    const log = recorder.build({ generatedAt: new Date(0) });
    expect(log.timeline).toHaveLength(GMEET_SYNC_LOG_MAX_ENTRIES);
    expect(log.droppedEntries).toBe(50);
    expect(log.timeline[0]!.meetingsChecked).toBe(0);
    expect(log.timeline.at(-1)!.meetingsChecked).toBe(GMEET_SYNC_LOG_MAX_ENTRIES + 49);
  });

  test("carries diagnostics counters, enum strings and phase timings, and the result kind", () => {
    const recorder = createGmeetSyncLogRecorder();
    recorder.setDiagnostics({
      drive_mode: "snapshot", drive_google_docs_discovered: 203, phase_drive_ms: 1234, phase_count_ms: 5,
      finishing_stalled_phase: "none",
    } as unknown as GmeetSyncDiagnostics);
    recorder.setResult({ kind: "storage", connectionSaved: false, notesDeferred: false });
    const log = recorder.build({ generatedAt: new Date(0) });
    expect(log.diagnostics).toEqual({
      drive_mode: "snapshot", drive_google_docs_discovered: 203, phase_drive_ms: 1234, phase_count_ms: 5,
      finishing_stalled_phase: "none",
    });
    expect(log.phaseTimingsMs).toEqual({ phase_drive_ms: 1234, phase_count_ms: 5 });
    expect(log.result).toEqual({ kind: "storage", connectionSaved: false, notesDeferred: false });
  });

  test("hostile input (token-like message, title, transcript text) never reaches the output", () => {
    const recorder = createGmeetSyncLogRecorder(() => 0);
    recorder.record(progress({
      type: "error", current: 1, total: 2,
      message: `Bearer ${TOKEN} ${TITLE}`,
      stage: TITLE as unknown as GmeetSyncProgress["stage"],
      notesDone: TRANSCRIPT as unknown as number,
    }));
    recorder.setDiagnostics({
      drive_mode: `${TOKEN}`, finishing_recovery_write: TITLE, drive_input_items: 3,
      title: TITLE, nested: { text: TRANSCRIPT }, token: TOKEN,
    } as unknown as GmeetSyncDiagnostics);
    const failed: GmeetSyncResult = {
      ok: false,
      error: { kind: "storage", message: `store said ${TOKEN} for ${TITLE}: ${TRANSCRIPT}`, googleStatus: TITLE },
      data: {
        windowStartIso: "", windowEndIso: "", total: 1, created: 0, updated: 0, skipped: 0, failed: 1, aborted: false,
        items: [{ sourceId: TITLE, outcome: "failed", reason: TRANSCRIPT } as never],
      },
      connectionSaved: true,
    };
    recorder.setResult(summarizeGmeetSyncResult(failed));
    recorder.setNotesOutcome({ ok: false, errorKind: TITLE as never });
    const text = JSON.stringify(recorder.build({ generatedAt: new Date(0), build: "Exo 0.9.0" }));
    for (const secret of [TOKEN, "SECRET", "Quarterly", "Alice", "confidential", "Bearer", "store said"]) {
      expect(text).not.toContain(secret);
    }
    const log = JSON.parse(text) as GmeetSyncLog;
    expect(log.timeline[0]).toMatchObject({ stage: "meetings", meetingsChecked: 1, meetingsTotal: 2, notesDone: null });
    expect(log.diagnostics).toEqual({ drive_input_items: 3 });
    expect(log.result).toEqual({ kind: "storage", connectionSaved: true, notesDeferred: false });
    expect(log.notesOutcome).toEqual({ ok: false, errorKind: null });
  });
});

describe("summarizeGmeetSyncResult", () => {
  const data = { windowStartIso: "", windowEndIso: "", total: 0, created: 0, updated: 0, skipped: 0, failed: 0, aborted: false, items: [] };
  test("names ok, deferred notes, a stopped run and unknown error kinds", () => {
    expect(summarizeGmeetSyncResult({ ok: true, data })).toEqual({ kind: "ok", connectionSaved: true, notesDeferred: false });
    expect(summarizeGmeetSyncResult({ ok: true, data: { ...data, notesDeferred: true } }).notesDeferred).toBe(true);
    expect(summarizeGmeetSyncResult({ ok: true, data: { ...data, aborted: true } }).kind).toBe("stopped");
    expect(summarizeGmeetSyncResult({ ok: false, data: null, error: { kind: TITLE as never, message: "x" } }))
      .toEqual({ kind: "unknown", connectionSaved: null, notesDeferred: false });
  });
});
