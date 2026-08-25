import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  LIBRARY_CATEGORIES,
  LibraryCategoryNav,
  type LibraryCategoryId,
} from "./connectorsNav";
import { MeetingsPage } from "./MeetingsPage";

interface LibraryPageProps {
  tcw: TinyCloudWeb;
  /** Which Library category is open. Meetings is the only one today. */
  category?: LibraryCategoryId;
  /**
   * The cohort meeting archive, owned by App because App owns the signed-in
   * session. Still optional: outside the backend-ingest cohort the section
   * renders nothing and leaves no empty placeholder behind.
   */
  meetingsSlot?: React.ReactNode;
}

/**
 * Library — the browsable half of Connectors: what the connected sources have
 * already synced, rather than how they are set up.
 *
 * Meetings is the only category, so its surface renders directly and the
 * category nav stays silent (see connectorsNav.tsx). Adding Documents means an
 * entry in LIBRARY_CATEGORIES and a branch here — the shape is already right.
 *
 * BOTH meeting data paths live here, unchanged: `MeetingsPage` reads the user's
 * OWN space through `tcw`, and `meetingsSlot` is the cohort read API's section.
 * They were on separate surfaces before this page existed; unifying their
 * placement did not merge or replace either one.
 */
export function LibraryPage({
  tcw,
  category = "meetings",
  meetingsSlot,
}: LibraryPageProps) {
  const label =
    LIBRARY_CATEGORIES.find((c) => c.id === category)?.label ?? "Meetings";

  return (
    <div className="flex flex-col gap-4">
      <LibraryCategoryNav active={category} />
      <div>
        <h2 className="text-sm font-semibold tracking-tight">{label}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Everything your connected sources have synced into your private space.
        </p>
      </div>
      <MeetingsPage tcw={tcw} />
      {meetingsSlot}
    </div>
  );
}
