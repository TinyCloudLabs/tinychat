import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { useDesktopWhisperJob } from "@/lib/voiceNotes/desktop/useDesktopWhisperJob";
import {
  registerDesktopWhisperQueue,
  type DesktopWhisperJob,
  type DesktopWhisperQueue,
} from "@/lib/voiceNotes/desktop/desktopWhisper";
import { DesktopWhisperStatus, DesktopWhisperStatusView, retryWhisperJob, useLogWhisperFailure, whisperJobMeta, WHISPER_JOB_COPY } from "./DesktopWhisperStatus";

const job = (patch: Partial<DesktopWhisperJob>): DesktopWhisperJob =>
  ({ id: "n1", state: "queued", error: null, progress: null, ...patch });

function fakeQueue() {
  const jobs = new Map<string, DesktopWhisperJob>();
  const listeners = new Set<() => void>();
  const retries: string[] = [];
  let retryError: Error | null = null;
  const queue = {
    snapshot: () => jobs,
    subscribe: (l: () => void) => { listeners.add(l); return () => void listeners.delete(l); },
    retry: async (id: string) => { retries.push(id); if (retryError) throw retryError; },
  } as unknown as DesktopWhisperQueue;
  return {
    queue, retries, listeners,
    publish(next: DesktopWhisperJob) { jobs.set(next.id, next); listeners.forEach((l) => l()); },
    failRetries(error: Error) { retryError = error; },
  };
}

describe("DesktopWhisperStatusView", () => {
  const view = (j: DesktopWhisperJob, retryError = false) =>
    renderToStaticMarkup(<DesktopWhisperStatusView job={j} retryError={retryError} onRetry={() => {}} />);

  test("queued, transcribing with progress, and done", () => {
    expect(view(job({ state: "queued" }))).toContain("Waiting to transcribe on this Mac");
    const html = view(job({ state: "transcribing", progress: 42.4 }));
    expect(html).toContain("Transcribing on this Mac · 42%");
    expect(html).toContain('role="status"');
    expect(view(job({ state: "transcribing", progress: null }))).toContain("Transcribing on this Mac…");
    expect(view(job({ state: "done" }))).toContain("Transcript saved.");
  });

  test("failed shows generic copy and Retry, never the raw error", () => {
    const html = view(job({ state: "failed", error: "unavailable: select a downloaded Whisper model" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Retry");
    expect(html).toContain("Check Whisper in ⚙︎ Settings");
    expect(html).not.toContain("unavailable:");
    expect(view(job({ state: "failed" }), true)).toContain(WHISPER_JOB_COPY.retryFailed);
  });

  test("the Recent row's meta", () => {
    expect(whisperJobMeta(job({ state: "queued" }))).toBe("Waiting to transcribe on this Mac");
    expect(whisperJobMeta(job({ state: "transcribing", progress: 7 }))).toBe("Transcribing on this Mac · 7%");
    expect(whisperJobMeta(job({ state: "failed" }))).toBe("Couldn’t transcribe on this Mac");
    expect(whisperJobMeta(job({ state: "done" }))).toBeNull();
  });
});

describe("DesktopWhisperStatus", () => {
  const saved = {
    window: (globalThis as { window?: unknown }).window,
    act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { window?: unknown }).window = { setTimeout, clearTimeout, event: undefined, HTMLIFrameElement: class {} };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved.window;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = saved.act;
  });
  afterEach(() => registerDesktopWhisperQueue(null));

  const fallback = <p data-testid="fallback">the existing status</p>;
  const mount = async (id = "n1") => {
    const seen: (DesktopWhisperJob | null)[] = [];
    function Probe() {
      const j = useDesktopWhisperJob(id);
      useLogWhisperFailure(id, j);
      seen.push(j);
      return null;
    }
    const container = { nodeType: 1, nodeName: "DIV", tagName: "DIV", ownerDocument: null, textContent: "",
      addEventListener() {}, removeEventListener() {} } as unknown as HTMLElement;
    const root = createRoot(container);
    await act(async () => root.render(<Probe />));
    return { root, seen };
  };

  test("no queue or no job for the note: the fallback, so the signed-in and phone states are unchanged", () => {
    expect(renderToStaticMarkup(<DesktopWhisperStatus noteId="n1" enabled fallback={fallback} />)).toContain("the existing status");
    const fake = fakeQueue();
    registerDesktopWhisperQueue(fake.queue);
    expect(renderToStaticMarkup(<DesktopWhisperStatus noteId="n1" enabled fallback={fallback} />)).toContain("the existing status");
    fake.publish(job({ id: "other", state: "failed" }));
    expect(renderToStaticMarkup(<DesktopWhisperStatus noteId="n1" enabled fallback={fallback} />)).toContain("the existing status");
  });

  test("a job shows its state, and a failure logs the raw error once", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeQueue();
    registerDesktopWhisperQueue(fake.queue);
    fake.publish(job({ state: "transcribing", progress: 10 }));
    expect(renderToStaticMarkup(<DesktopWhisperStatus noteId="n1" enabled fallback={fallback} />)).toContain("Transcribing on this Mac · 10%");
    fake.publish(job({ state: "failed", error: "fixture failed" }));
    const html = renderToStaticMarkup(<DesktopWhisperStatus noteId="n1" enabled fallback={fallback} />);
    expect(html).toContain("Retry");
    expect(html).not.toContain("fixture failed");
    const { root } = await mount();
    const logged = () => error.mock.calls.filter((c) => c[2] === "fixture failed").length;
    expect(logged()).toBe(1);
    await act(async () => root.unmount());
    error.mockRestore();
  });

  test("the job updates live while mounted, and unsubscribes", async () => {
    const fake = fakeQueue();
    registerDesktopWhisperQueue(fake.queue);
    fake.publish(job({ state: "queued" }));
    const { root, seen } = await mount();
    expect(fake.listeners.size).toBe(1);
    await act(async () => fake.publish(job({ state: "transcribing", progress: 50 })));
    expect(seen.at(-1)).toMatchObject({ state: "transcribing", progress: 50 });
    await act(async () => fake.publish(job({ state: "done" })));
    expect(seen.at(-1)?.state).toBe("done");
    await act(async () => root.unmount());
    expect(fake.listeners.size).toBe(0);
  });

  test("Retry goes through the queue, and a refusal is logged and surfaced", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeQueue();
    registerDesktopWhisperQueue(fake.queue);
    let failed = 0;
    retryWhisperJob("n1", () => void failed++);
    await Bun.sleep(0);
    expect(fake.retries).toEqual(["n1"]);
    expect(failed).toBe(0);
    fake.failRetries(new Error("no model"));
    retryWhisperJob("n1", () => void failed++);
    await Bun.sleep(0);
    expect(failed).toBe(1);
    registerDesktopWhisperQueue(null);
    retryWhisperJob("n1", () => void failed++);
    expect(failed).toBe(2);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
