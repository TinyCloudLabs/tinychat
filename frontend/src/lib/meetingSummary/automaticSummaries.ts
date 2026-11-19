// The "Automatic meeting summaries" setting, synced through the settings table. On by default: a combine starts a
// summary run. Off: a combine saves the meeting without one, and the user starts it with Generate.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getSetting, setSetting } from "@/lib/threadStore";
import type { SummaryRunner } from "./summaryRunner";

export const AUTOMATIC_SUMMARIES_KEY = "automatic-meeting-summaries";

/** True unless the user turned it off. An unset key means on. Throws when the setting cannot be read. */
export async function readAutomaticSummaries(tcw: TinyCloudWeb): Promise<boolean> {
  return (await getSetting(tcw, AUTOMATIC_SUMMARIES_KEY)) !== "false";
}

export async function writeAutomaticSummaries(tcw: TinyCloudWeb, enabled: boolean): Promise<void> {
  await setSetting(tcw, AUTOMATIC_SUMMARIES_KEY, enabled ? "true" : "false");
}

/**
 * A combine's summary decision, once its text is saved.
 * - Setting on (or unreadable): start a run. A Re-combine replaces the old summary.
 * - Setting off: a Re-combine drops the old summary (no run); a new meeting gets no summary until Generate.
 * An unreadable setting counts as on, the default: a read error never turns summaries off.
 */
export async function gateCombinedSummary(
  automaticOn: () => Promise<boolean>,
  summaries: Pick<SummaryRunner, "start" | "clear"> | undefined,
  combined: { id: string; created: boolean },
): Promise<void> {
  const on = await automaticOn().catch(() => true);
  if (on) summaries?.start(combined.id, { replacing: !combined.created });
  else if (!combined.created) summaries?.clear(combined.id);
}
