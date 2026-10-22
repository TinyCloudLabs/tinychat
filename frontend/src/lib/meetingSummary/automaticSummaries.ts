// The "Automatic meeting summaries" setting, synced through the settings table. On by default: a combine starts a
// summary run. Off: a combine saves the meeting without one, and the user starts it with Generate.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getSetting, setSetting } from "@/lib/threadStore";

export const AUTOMATIC_SUMMARIES_KEY = "automatic-meeting-summaries";

/** True unless the user turned it off. An unset key means on. */
export async function readAutomaticSummaries(tcw: TinyCloudWeb): Promise<boolean> {
  return (await getSetting(tcw, AUTOMATIC_SUMMARIES_KEY)) !== "false";
}

export async function writeAutomaticSummaries(tcw: TinyCloudWeb, enabled: boolean): Promise<void> {
  await setSetting(tcw, AUTOMATIC_SUMMARIES_KEY, enabled ? "true" : "false");
}
