// Page side of recorder-final-web-engine.e2e.test.ts: the web engine as the app starts it
// (startWebCaptureEngine: real IndexedDB, real MediaRecorder, boot recovery) behind a few functions.
import { startWebCaptureEngine } from "../frontend/src/lib/voiceNotes/web/webEngine";
import { openWebStore } from "../frontend/src/lib/voiceNotes/web/webStore";

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const api = {
  /** Boot the engine on this database, then record until at least `audioMs` is durable. The test then kills the page. */
  async recordUntil(dbName: string, audioMs: number) {
    const engine = await startWebCaptureEngine({ store: await openWebStore({ dbName }) });
    const { id } = await engine.start();
    for (let i = 0; i < 250; i++) {
      const status = await engine.status();
      if (status.audioMs >= audioMs) return { id, audioMs: status.audioMs };
      await wait(100);
    }
    throw new Error("The recorder never reached the requested audio length.");
  },

  /** What the app does at boot in a fresh page: start the engine (recovery runs inside), then list what is pending. */
  async boot(dbName: string) {
    const recoveryFailed: unknown[] = [];
    const engine = await startWebCaptureEngine({ store: await openWebStore({ dbName }) });
    await engine.addListener("recoveryFailed", (event) => { recoveryFailed.push(event); });
    await wait(50);
    const { recordings } = await engine.listPending();
    return {
      capabilities: engine.capabilities,
      recoveryFailed,
      pending: recordings.map((r) => ({ id: r.id, mimeType: r.mimeType, sizeBytes: r.sizeBytes, durationMs: r.durationMs, recovered: r.recovered })),
    };
  },
};

export type WebEngineApi = typeof api;
(window as unknown as { engine: WebEngineApi }).engine = api;
