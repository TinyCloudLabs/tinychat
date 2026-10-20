// TC-1152 S2c-1: how a combined meeting (`source = 'exo-merged'`) is shown.
//
// WHAT A COMBINED MEETING IS is decided by its row's `source` alone. The Library list and the Delete
// action never read `metadata.merge`: a row whose metadata is missing, truncated or garbage is still
// listed and still deletable. The members below are DISPLAY ONLY ("Combined from Fireflies +
// Notetaker", links to the originals); unreadable metadata just shows a plainer sentence.
import { EXO_MERGED_SOURCE } from "@tinyboilerplate/core";

import { notePath } from "@/shell/routes";
import { librarySourceLabel } from "../libraryKinds";
import type { LibraryItem } from "../LibraryRow";

export interface CombinedMemberRef {
  source: string;
  sourceId: string;
}

export interface CombinedMemberLine extends CombinedMemberRef {
  sourceLabel: string;
  /** The original's title; null when it is no longer in the Library. */
  title: string | null;
  /** The original's page; null when it is no longer in the Library. */
  href: string | null;
}

export const isCombined = (item: Pick<LibraryItem, "source">): boolean => item.source === EXO_MERGED_SOURCE;

/** Members named by `metadata.merge.members`, or [] when the metadata is not that shape (never throws). */
export function displayMembers(metadata: Record<string, unknown> | null): CombinedMemberRef[] {
  const members = (metadata?.merge as { members?: unknown } | null | undefined)?.members;
  if (!Array.isArray(members)) return [];
  const out: CombinedMemberRef[] = [];
  for (const m of members as ({ source?: unknown; source_id?: unknown } | null)[]) {
    if (typeof m?.source === "string" && m.source !== "" && typeof m.source_id === "string" && m.source_id !== "") out.push({ source: m.source, sourceId: m.source_id });
  }
  return out;
}

/** Each member with its title and link when the original is still listed. */
export function memberLines(members: readonly CombinedMemberRef[], items: readonly LibraryItem[]): CombinedMemberLine[] {
  return members.map((m) => {
    const found = items.find((item) => item.source === m.source && item.sourceId === m.sourceId);
    return { ...m, sourceLabel: librarySourceLabel(m.source), title: found ? (found.title ?? "Untitled") : null, href: found ? notePath(found.id) : null };
  });
}

/** What NoteDetailView needs for Combine; absent where there is no space to combine in (the on-device screen). */
export interface CombineDetail {
  /** "Combine with another capture…" on a meeting capture that can be combined. */
  onCombine?: () => void;
  /** Present on a combined meeting. */
  combined?: {
    members: CombinedMemberLine[];
    /** A member's text changed since combining. */
    stale: boolean;
    /** Absent when a member is no longer in the Library. */
    onRecombine?: () => void;
    onDelete: () => void;
  };
}
