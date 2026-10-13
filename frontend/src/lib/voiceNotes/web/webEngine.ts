// The lazy chunk behind registerWebCaptureEngine: opens the browser store, builds the web
// VoiceNotes engine and recovers interrupted sessions before anything else can use it.

import type { CaptureEngine } from "../captureEngine";
import type { WebStore } from "./webStore";
import { openWebStore } from "./webStore";
import { createWebVoiceNotes, type WebVoiceNotesOptions } from "./webVoiceNotes";

/** Boot recovery runs here, so it is finished before installCaptureEngine() resolves and PendingVoiceNotesSaver starts. */
export async function startWebCaptureEngine(options: WebVoiceNotesOptions): Promise<CaptureEngine> {
  const web = createWebVoiceNotes(options);
  await web.recoverAtBoot();
  return { ...web.plugin, capabilities: web.capabilities };
}

export async function createBrowserCaptureEngine(): Promise<CaptureEngine> {
  const store: WebStore = await openWebStore();
  return startWebCaptureEngine({ store });
}
