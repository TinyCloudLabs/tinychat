import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "../captureEvents";
import type { SpeakerNames } from "./speakerNames";
import { canSuggestNames, currentNameSuggestions, shownNameSuggestions, type ShownNameSuggestions } from "@/lib/speakerNaming/nameSuggestions";
import { speakerNameSuggestionsEnabled } from "@/lib/speakerNaming/namingFeature";
import type { NamingRunner } from "@/lib/speakerNaming/namingRunner";
import { dismissRowNameSuggestions } from "@/lib/voiceNotes/nameSuggestionRows";

export interface NameSuggestionsController {
  /** Stored label -> the name suggested for it, for the labels that show a suggestion now. */
  names: ShownNameSuggestions;
  dismiss: (label: string) => void;
  /** The menu's "Suggest names"; null on a note whose speakers cannot be named (an on-device or pasted transcript). */
  suggest: (() => void) | null;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The open voice note's suggested speaker names. Opening the note asks the runner to name its speakers (it runs only
 * when that is due). A suggestion shows until its label is named or it is dismissed; a dismissal hides it at once
 * and is saved with the suggestions it is about. Undefined when suggestions are off in this build, there is no
 * runner, the note is not a voice note in the space, or its names cannot be saved (`overrides` undefined).
 */
export function useNameSuggestions(options: {
  tcw: TinyCloudWeb;
  naming: NamingRunner | undefined;
  /** The note's row; null unless it is a voice note saved to the space. */
  row: { id: string; source: string; sourceId: string } | null;
  metadata: unknown;
  /** The names the user has given (`useSpeakerNames`), as shown now. */
  overrides: SpeakerNames | undefined;
}): NameSuggestionsController | undefined {
  const { tcw, row, metadata, overrides } = options;
  const naming = speakerNameSuggestionsEnabled() ? options.naming : undefined;
  const sourceId = row?.sourceId ?? null;
  const hash = currentNameSuggestions(metadata)?.hash ?? null;
  // A dismissal belongs to one note's suggestions for one transcript; under another key it is forgotten.
  const key = row !== null && hash !== null ? `${row.id}\n${hash}` : null;
  const [local, setLocal] = useState<{ key: string; labels: ReadonlySet<string> } | null>(null);
  const dismissed = local !== null && local.key === key ? local.labels : NONE;
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  useEffect(() => {
    if (naming !== undefined && sourceId !== null) naming.consider(sourceId);
  }, [naming, sourceId]);

  const dismiss = useCallback((label: string) => {
    const stored = currentNameSuggestions(metadata);
    if (row === null || key === null || stored === null) return;
    const labels = new Set([...stored.dismissed, ...dismissedRef.current, label]);
    dismissedRef.current = labels;
    setLocal({ key, labels });
    void dismissRowNameSuggestions(tcw, row.id, stored.hash, [...labels]).then(
      () => captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId }),
      // Not saved: the suggestion shows again.
      () => setLocal((current) => current?.key === key ? { key, labels: new Set([...current.labels].filter((kept) => kept !== label)) } : current),
    );
  }, [tcw, row, key, metadata]);

  const names = useMemo(
    () => overrides === undefined ? undefined : shownNameSuggestions(metadata, overrides, dismissed),
    [metadata, overrides, dismissed],
  );
  const offered = canSuggestNames(metadata);
  const suggest = useMemo(
    () => naming !== undefined && sourceId !== null && offered ? () => naming.suggest(sourceId) : null,
    [naming, sourceId, offered],
  );
  return useMemo(
    () => naming === undefined || row === null || names === undefined ? undefined : { names, dismiss, suggest },
    [naming, row, names, dismiss, suggest],
  );
}
