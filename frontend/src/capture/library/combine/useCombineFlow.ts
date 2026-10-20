// TC-1152 S2c-1: the Combine flow's state machine (ask first, one tap).
//
//   idle -> pick -> analyzing -> confirm -> writing -> idle (combined)
//                         \-> tooLarge | error                (every step: cancel -> idle)
//
// INVARIANTS
//   - Nothing is written until `confirm` runs from the confirm step. Everything before it reads
//     (`readCombinePair`) and stitches in memory.
//   - A pair the stitcher refused is written only by `confirm(true)` ("Combine anyway"), which
//     stitches with `force` so the row records `detection.passed = false`. `confirm(false)` on a
//     refused pair does nothing.
//   - Member rows are never written: the only writer is `writeCombined` (exo-merged rows only).
//   - All storage calls go through the per-space queue, like every other Library read.
//   - No state outlives this component, and a change of account (tcw) cancels and clears it
//     (TC-1376: nothing here is keyed by anything but the signed-in account's own space).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StitchInputError, type MeetingSnapshot, type StitchResult } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { readCombinePair, writeCombined, type MeetingRef } from "@/lib/connectors/combinedMeetingStore";
import { scheduledSpace } from "@/lib/spaceQueue";
import type { LibraryItem } from "../LibraryRow";
import { bodySegments, COMBINE_MAX_SEGMENTS_PER_MEMBER } from "./bodySegments";
import { describeEvidence, type CombineEvidence } from "./evidence";
import { startStitch, StitchCancelled, type StitchRun, type StitchStarter } from "./stitchRunner";

/** What `readCombinePair` returns, as the fixed pair it always is. */
type SnapshotPair = readonly [MeetingSnapshot, MeetingSnapshot];

export type CombineState =
  | { step: "idle" }
  | { step: "pick"; source: LibraryItem }
  | { step: "analyzing"; source: LibraryItem; other: LibraryItem }
  | { step: "confirm"; source: LibraryItem; other: LibraryItem; evidence: CombineEvidence }
  | { step: "writing"; source: LibraryItem; other: LibraryItem; stage: "stitching" | "saving" }
  | { step: "tooLarge"; source: LibraryItem; other: LibraryItem; segments: number }
  | { step: "error"; source: LibraryItem; other: LibraryItem; message: string; retry: "analyze" | "confirm" | null; forced: boolean };

export interface CombineFlow {
  state: CombineState;
  /** Open the flow for `source`; with `other` (Re-combine) it goes straight to checking that pair. */
  open: (source: LibraryItem, other?: LibraryItem) => void;
  pick: (other: LibraryItem) => void;
  /** The explicit tap. `force` is "Combine anyway" and is honoured only for a pair the check refused. */
  confirm: (force: boolean) => void;
  retry: () => void;
  /** Close the flow; stops a check in progress. Ignored while the combined meeting is being saved. */
  cancel: () => void;
}

export interface CombineFlowOptions {
  tcw: TinyCloudWeb;
  /** A combined meeting was written; `id` is its Library row id. */
  onCombined: (id: string) => void;
  /** The stitcher's runner (tests inject one). */
  stitch?: StitchStarter;
  now?: () => Date;
}

const ref = (item: LibraryItem): MeetingRef => ({ source: item.source, sourceId: item.sourceId });

function inputMessage(error: StitchInputError): string {
  if (/gemini/i.test(error.message)) return "One of these is a Gemini notes summary. It has no transcript to combine.";
  if (/no text/i.test(error.message)) return "One of these captures has no transcript text to combine.";
  return "These two captures can't be combined.";
}

const READ_FAILED = "Couldn't read one of the two captures. Check your connection and try again. Nothing was changed.";
const WRITE_FAILED = "Couldn't save the combined meeting. Your original captures were not changed.";

export function useCombineFlow(options: CombineFlowOptions): CombineFlow {
  const { tcw, onCombined } = options;
  const stitch = options.stitch ?? startStitch;
  const space = useMemo(() => scheduledSpace(tcw), [tcw]);
  const [state, setState] = useState<CombineState>({ step: "idle" });
  // A newer action, a cancel or an unmount makes every older await a no-op.
  const token = useRef(0);
  const running = useRef<StitchRun | null>(null);
  // What the confirm step stitched, kept off React state (it is large) and only for the open confirm step.
  const held = useRef<{ result: StitchResult; a: LibraryItem; b: LibraryItem; snapshots: SnapshotPair } | null>(null);
  const latest = useRef({ onCombined, now: options.now });
  latest.current = { onCombined, now: options.now };

  const stop = useCallback(() => {
    token.current++;
    running.current?.cancel();
    running.current = null;
    held.current = null;
  }, []);
  // Another account's space (or unmount): stop and forget everything.
  useEffect(() => () => { stop(); setState({ step: "idle" }); }, [stop, tcw]);

  const analyze = useCallback(async (source: LibraryItem, other: LibraryItem) => {
    stop();
    const mine = token.current;
    const live = () => token.current === mine;
    setState({ step: "analyzing", source, other });
    const pair = await readCombinePair(space, ref(source), ref(other));
    if (!live()) return;
    if (!pair.ok) return setState({ step: "error", source, other, message: READ_FAILED, retry: "analyze", forced: false });
    const segments = Math.max(...pair.data.map((snap) => bodySegments(snap.body)?.length ?? 0));
    if (segments > COMBINE_MAX_SEGMENTS_PER_MEMBER) return setState({ step: "tooLarge", source, other, segments });
    const pairOf: SnapshotPair = [pair.data[0]!, pair.data[1]!];
    const run = stitch(pairOf[0], pairOf[1], {});
    running.current = run;
    let result: StitchResult;
    try {
      result = await run.promise;
    } catch (error) {
      if (error instanceof StitchCancelled || !live()) return;
      return setState({ step: "error", source, other, message: error instanceof StitchInputError ? inputMessage(error) : "Couldn't check these captures. Nothing was changed.", retry: error instanceof StitchInputError ? null : "analyze", forced: false });
    }
    if (!live()) return;
    running.current = null;
    held.current = { result, a: source, b: other, snapshots: pairOf };
    setState({ step: "confirm", source, other, evidence: describeEvidence(result, [source, other], pairOf) });
  }, [space, stitch, stop]);

  const write = useCallback(async (source: LibraryItem, other: LibraryItem, force: boolean) => {
    const prior = held.current;
    if (prior === null) return;
    const mine = ++token.current;
    const live = () => token.current === mine;
    let result = prior.result;
    if (result.combined === null) {
      // "Combine anyway": the stitcher lays the pair end to end only when told to, and records passed=false.
      setState({ step: "writing", source, other, stage: "stitching" });
      const run = stitch(prior.snapshots[0], prior.snapshots[1], { force: true });
      running.current = run;
      try {
        result = await run.promise;
      } catch (error) {
        if (error instanceof StitchCancelled || !live()) return;
        return setState({ step: "error", source, other, message: error instanceof StitchInputError ? inputMessage(error) : "Couldn't prepare the combined meeting. Nothing was changed.", retry: error instanceof StitchInputError ? null : "confirm", forced: force });
      }
      if (!live()) return;
      running.current = null;
    }
    setState({ step: "writing", source, other, stage: "saving" });
    const written = await writeCombined(space, result, { now: latest.current.now });
    if (!live()) return;
    if (!written.ok) return setState({ step: "error", source, other, message: WRITE_FAILED, retry: "confirm", forced: force });
    held.current = null;
    setState({ step: "idle" });
    latest.current.onCombined(written.data.id);
  }, [space, stitch]);

  const confirm = useCallback((force: boolean) => {
    if (state.step !== "confirm") return;
    // A pair that passed is written as it is; one that did not is written only on the explicit "Combine anyway".
    if (!state.evidence.passed && !force) return;
    void write(state.source, state.other, !state.evidence.passed);
  }, [state, write]);

  const retry = useCallback(() => {
    if (state.step !== "error") return;
    if (state.retry === "analyze") void analyze(state.source, state.other);
    else if (state.retry === "confirm") void write(state.source, state.other, state.forced);
  }, [state, analyze, write]);

  const cancel = useCallback(() => {
    if (state.step === "writing" && state.stage === "saving") return;
    stop();
    setState({ step: "idle" });
  }, [state, stop]);

  const open = useCallback((source: LibraryItem, other?: LibraryItem) => {
    if (other) void analyze(source, other);
    else { stop(); setState({ step: "pick", source }); }
  }, [analyze, stop]);

  const pick = useCallback((other: LibraryItem) => {
    if (state.step === "pick") void analyze(state.source, other);
  }, [state, analyze]);

  return { state, open, pick, confirm, retry, cancel };
}
