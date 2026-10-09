import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import type { AppPlatform } from "@/lib/platform";
import { detailWhen, formatSpokenDuration } from "../formatters";
import type { LibraryItem } from "../LibraryRow";
import { SAVED_NOTE_COPY } from "./savedNoteCopy";

const PRIVATE_CLOUD = "tinycloud-private-transcription";

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/** Where it was recorded: the phone that did, else this device. */
function recordedOn(
  metadata: Record<string, unknown> | null,
  platform: AppPlatform,
): string | null {
  const captured = (metadata?.capture as { platform?: unknown } | undefined)
    ?.platform;
  switch (text(captured)) {
    case "ios":
      return "recorded on iPhone";
    case "android":
      return "recorded on Android phone";
    case "tauri":
      return "recorded on this Mac";
    case "web":
      return "recorded in the browser";
  }
  // A note made here before the platform was recorded on it.
  return platform === "tauri" ? "recorded on this Mac" : null;
}

function transcriptRoute(metadata: Record<string, unknown> | null): string | null {
  const provider = text(metadata?.transcript_provider);
  const engine = text(metadata?.transcription_engine);
  if (provider === PRIVATE_CLOUD || engine === "private-cloud")
    return "Private cloud transcript";
  if (provider === "assemblyai") return "AssemblyAI transcript";
  if (provider === "whispercpp") return "Local transcript";
  return null;
}

/** The saved note's meta line: "Oct 8, 2026 · 12:10 PM · 1 min · recorded on iPhone · Local transcript · saved to your space". */
export function savedNoteMeta(
  item: LibraryItem,
  metadata: Record<string, unknown> | null,
  platform: AppPlatform,
): string {
  return [
    detailWhen(item.startedAt),
    item.durationSecs !== null ? formatSpokenDuration(item.durationSecs) : null,
    item.source === VOICE_NOTE_SOURCE ? recordedOn(metadata, platform) : null,
    transcriptRoute(metadata),
    SAVED_NOTE_COPY.savedToSpace,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
}
