// TC-1152 S2c-1: stitch two members without freezing the screen.
//
// The stitcher is a pure synchronous function that can take seconds on a long meeting. Where the
// browser (or webview) can start a module Worker it runs there, and cancelling terminates the
// Worker, so a cancelled run really stops. Where it cannot (no Worker, a test runner, a webview that
// refuses one, or a build that does not emit it) it runs on the calling thread after a macrotask turn so the loading state paints
// first; the size guard (bodySegments.ts) bounds that case.
import { StitchInputError, stitchMeetings, type MeetingSnapshot, type StitchOptions, type StitchResult } from "@tinyboilerplate/core";

import type { StitchReply, StitchRequest } from "./stitch.worker";

export interface StitchRun {
  promise: Promise<StitchResult>;
  /** Stops the run; its promise rejects with `StitchCancelled`. */
  cancel: () => void;
}

export class StitchCancelled extends Error {
  constructor() {
    super("The combine was cancelled");
    this.name = "StitchCancelled";
  }
}

export type StitchStarter = (a: MeetingSnapshot, b: MeetingSnapshot, options: StitchOptions) => StitchRun;

let workerUnavailable = false;
let nextRequest = 0;

function workerSupported(): boolean {
  return !workerUnavailable && typeof window !== "undefined" && typeof document !== "undefined" && !("Bun" in globalThis) && typeof Worker !== "undefined";
}

function inline(a: MeetingSnapshot, b: MeetingSnapshot, options: StitchOptions): StitchRun {
  let cancelled = false;
  let cancelRun: () => void = () => undefined;
  // withResolvers is newer than this project's lib target and some webviews.
  const promise = new Promise<StitchResult>((resolve, reject) => {
    cancelRun = () => { cancelled = true; reject(new StitchCancelled()); };
    setTimeout(() => {
      if (cancelled) return;
      try { resolve(stitchMeetings(a, b, options)); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
    }, 0);
  });
  return { promise, cancel: () => cancelRun() };
}

function inWorker(a: MeetingSnapshot, b: MeetingSnapshot, options: StitchOptions): StitchRun | null {
  let worker: Worker;
  try {
    worker = new Worker(new URL("./stitch.worker.ts", import.meta.url), { type: "module" });
  } catch {
    workerUnavailable = true;
    return null;
  }
  const request = ++nextRequest;
  let settle: { resolve: (r: StitchResult) => void; reject: (e: Error) => void } = { resolve: () => undefined, reject: () => undefined };
  const promise = new Promise<StitchResult>((resolve, reject) => { settle = { resolve, reject }; });
  let fallback: StitchRun | null = null;
  let cancelled = false;
  worker.onmessage = (event: MessageEvent<StitchReply>) => {
    if (event.data.request !== request) return;
    worker.terminate();
    if ("result" in event.data) settle.resolve(event.data.result);
    else settle.reject(event.data.error.input ? new StitchInputError(event.data.error.message) : new Error(event.data.error.message));
  };
  worker.onerror = () => {
    // A webview (or build) that cannot run the Worker: remember it and run on this thread instead.
    workerUnavailable = true;
    worker.terminate();
    if (cancelled) return;
    fallback = inline(a, b, options);
    fallback.promise.then(settle.resolve, settle.reject);
  };
  try {
    worker.postMessage({ request, a, b, options } satisfies StitchRequest);
  } catch {
    workerUnavailable = true;
    worker.terminate();
    return null;
  }
  return { promise, cancel: () => { cancelled = true; worker.terminate(); fallback?.cancel(); settle.reject(new StitchCancelled()); } };
}

/** The production starter: a Worker where there is one, else the calling thread. */
export const startStitch: StitchStarter = (a, b, options) => (workerSupported() ? inWorker(a, b, options) : null) ?? inline(a, b, options);
