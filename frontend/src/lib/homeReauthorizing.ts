// The one boundary between a Home re-authorise and the work a session swap must not cut off (a recording, an upload).
// Work is admitted only while no re-authorise is in progress, and holds its place until it ends; a re-authorise keeps
// its new session only while no admitted work is running.
type HomeWork = "recording" | "upload";

let reauthorizing = false;
const running: Record<HomeWork, number> = { recording: 0, upload: 0 };
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function setHomeReauthorizing(value: boolean): void {
  reauthorizing = value;
  notify();
}

export function isHomeReauthorizing(): boolean {
  return reauthorizing;
}

/** Changes to either side of the boundary: a re-authorise starting or ending, work starting or ending. */
export function subscribeHomeReauthorizing(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Bumped by the test reset: a place held before it is forgotten, and its later release changes nothing.
let holdGeneration = 0;

/** Count `kind` as running until the returned release is called (once; later calls do nothing). */
export function holdHomeWork(kind: HomeWork): () => void {
  running[kind] += 1;
  notify();
  let released = false;
  const generation = holdGeneration;
  return () => {
    if (released) return;
    released = true;
    if (generation !== holdGeneration) return;
    running[kind] -= 1;
    notify();
  };
}

/** Start `kind` of work: its release, or null (refused) while a re-authorise is in progress. */
export function admitHomeWork(kind: HomeWork): (() => void) | null {
  return reauthorizing ? null : holdHomeWork(kind);
}

/** Admitted work still running, by kind. */
export function homeWorkRunning(kind?: HomeWork): boolean {
  return kind ? running[kind] > 0 : running.recording + running.upload > 0;
}

/** Tests only: forget every held place and any re-authorise (test files share this module). */
export function __resetHomeWorkForTests(): void {
  reauthorizing = false;
  running.recording = 0;
  running.upload = 0;
  holdGeneration += 1;
  notify();
}
