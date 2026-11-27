import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CALENDAR_LINK_KEY, parseCalendarLink } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { captureEvents } from "../captureEvents";
import { readCallParticipants } from "./callParticipants";
import type { SpeakerNames } from "./speakerNames";
import { calendarLinkingEnabled } from "@/lib/calendarLink/calendarLinkFeature";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { dismissedInviteeLabels, inviteeSuggestion } from "@/lib/speakerNaming/inviteeSuggestion";
import { canSuggestNames, currentNameSuggestions, shownNameSuggestions, type ShownNameSuggestions } from "@/lib/speakerNaming/nameSuggestions";
import { speakerNameSuggestionsEnabled } from "@/lib/speakerNaming/namingFeature";
import type { NamingRunner } from "@/lib/speakerNaming/namingRunner";
import { INVITED_BASIS } from "@/lib/speakerNaming/parseNaming";
import { dismissRowInviteeSuggestion, dismissRowNameSuggestions } from "@/lib/voiceNotes/nameSuggestionRows";

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
 *
 * With calendar linking on, a label no naming run has a name for may show the one other person invited to the
 * note's linked event instead ("Invited to this meeting", inviteeSuggestion.ts), whether or not a run was made. It
 * is offered like any other suggestion and never applied: its dismissal is saved for the event it was about.
 */
export function useNameSuggestions(options: {
  tcw: TinyCloudWeb;
  naming: NamingRunner | undefined;
  /** The note's row; null unless it is a voice note saved to the space. */
  row: { id: string; source: string; sourceId: string } | null;
  metadata: unknown;
  /** The names the user has given (`useSpeakerNames`), as shown now. */
  overrides: SpeakerNames | undefined;
  /** The transcript's sentences as stored (their labels before any rename); without them no invitee is suggested. */
  sentences?: readonly FirefliesSentence[] | null;
}): NameSuggestionsController | undefined {
  const { tcw, row, metadata, overrides, sentences } = options;
  const naming = speakerNameSuggestionsEnabled() ? options.naming : undefined;
  const sourceId = row?.sourceId ?? null;
  const hash = currentNameSuggestions(metadata)?.hash ?? null;
  // A dismissal belongs to one note's suggestions for one transcript; under another key it is forgotten.
  const key = row !== null && hash !== null ? `${row.id}\n${hash}` : null;
  const [local, setLocal] = useState<{ key: string; labels: ReadonlySet<string> } | null>(null);
  const dismissed = local !== null && local.key === key ? local.labels : NONE;
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;

  // The invitee the note's calendar link suggests, with the event it is of.
  const invited = useMemo(() => {
    if (!calendarLinkingEnabled() || !sentences || metadata === null || typeof metadata !== "object") return null;
    const link = parseCalendarLink((metadata as Record<string, unknown>)[CALENDAR_LINK_KEY]);
    const found = inviteeSuggestion(link, readCallParticipants(metadata), sentences);
    return found === null || link?.event_id === undefined ? null : { ...found, eventId: link.event_id };
  }, [metadata, sentences]);
  // Its dismissal belongs to one note linked to one event.
  const invitedKey = row !== null && invited !== null ? `${row.id}\n${invited.eventId}` : null;
  const [invitedLocal, setInvitedLocal] = useState<{ key: string; labels: ReadonlySet<string> } | null>(null);
  const invitedDismissed = invitedLocal !== null && invitedLocal.key === invitedKey ? invitedLocal.labels : NONE;
  const invitedDismissedRef = useRef(invitedDismissed);
  invitedDismissedRef.current = invitedDismissed;

  useEffect(() => {
    if (naming !== undefined && sourceId !== null) naming.consider(sourceId);
  }, [naming, sourceId]);

  const dismiss = useCallback((label: string) => {
    const stored = currentNameSuggestions(metadata);
    if (row === null) return;
    // The label shows the invitee only where no run has a name for it.
    if (invited !== null && invitedKey !== null && invited.label === label && (stored === null || !Object.hasOwn(stored.names, label))) {
      const labels = new Set([...dismissedInviteeLabels(metadata, invited.eventId), ...invitedDismissedRef.current, label]);
      invitedDismissedRef.current = labels;
      setInvitedLocal({ key: invitedKey, labels });
      void dismissRowInviteeSuggestion(tcw, row.id, invited.eventId, [...labels]).then(
        () => captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId }),
        // Not saved: the suggestion shows again.
        () => setInvitedLocal((current) => current?.key === invitedKey
          ? { key: invitedKey, labels: new Set([...current.labels].filter((kept) => kept !== label)) } : current),
      );
      return;
    }
    if (key === null || stored === null) return;
    const labels = new Set([...stored.dismissed, ...dismissedRef.current, label]);
    dismissedRef.current = labels;
    setLocal({ key, labels });
    void dismissRowNameSuggestions(tcw, row.id, stored.hash, [...labels]).then(
      () => captureEvents.emit("library-changed", { source: row.source, sourceId: row.sourceId }),
      // Not saved: the suggestion shows again.
      () => setLocal((current) => current?.key === key ? { key, labels: new Set([...current.labels].filter((kept) => kept !== label)) } : current),
    );
  }, [tcw, row, key, metadata, invited, invitedKey]);

  const names = useMemo((): ShownNameSuggestions | undefined => {
    if (overrides === undefined) return undefined;
    const shown = shownNameSuggestions(metadata, overrides, dismissed);
    if (invited === null || Object.hasOwn(overrides, invited.label) || invitedDismissed.has(invited.label)
      || dismissedInviteeLabels(metadata, invited.eventId).includes(invited.label)) return shown;
    // A name a run suggested for the label stands in the invitee's place, shown or dismissed.
    const stored = currentNameSuggestions(metadata);
    if (stored !== null && Object.hasOwn(stored.names, invited.label)) return shown;
    return Object.freeze({ ...shown, [invited.label]: { name: invited.name, basis: INVITED_BASIS, quote: "" } });
  }, [metadata, overrides, dismissed, invited, invitedDismissed]);
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
