// The "Suggest speaker names" setting, synced through the settings table. On by default: a transcribed voice note
// gets a naming run on its own. Off: only the note menu's "Suggest names" starts one.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getSetting, setSetting } from "@/lib/threadStore";

export const SUGGEST_SPEAKER_NAMES_KEY = "suggest-speaker-names";

/** True unless the user turned it off. An unset key means on. Throws when the setting cannot be read. */
export async function readSuggestSpeakerNames(tcw: TinyCloudWeb): Promise<boolean> {
  return (await getSetting(tcw, SUGGEST_SPEAKER_NAMES_KEY)) !== "false";
}

export async function writeSuggestSpeakerNames(tcw: TinyCloudWeb, enabled: boolean): Promise<void> {
  await setSetting(tcw, SUGGEST_SPEAKER_NAMES_KEY, enabled ? "true" : "false");
}
