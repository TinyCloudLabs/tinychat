// What is left of the Connectors tabs (TC-761). Library moved to Capture
// (/chat/capture/library) and Connectors is one page again, so the Sources |
// Library tab strip is gone; shell/routes.ts owns the addresses now. The path
// constants and the Library categories stay here until note detail replaces
// LibraryPage (PR6), because LibraryPage and chatViewPath.test.ts import them.
//
// Nothing here touches `tcw`, a session or storage.

import { Link } from "react-router-dom";

import { PATHS } from "../shell/routes";

/** Connectors, one page. */
export const CONNECTORS_SOURCES_PATH = PATHS.connectors;
/** Library's address while it was a Connectors tab; now a legacy address that forwards to Capture → Library. */
export const CONNECTORS_LIBRARY_PATH = "/chat/connectors/library";

export type LibraryCategoryId = "meetings";

/**
 * What Library can show. Meetings is the whole list today; a Documents entry
 * drops in here (plus its surface in LibraryPage) and the category nav below
 * turns itself on. Nothing disabled or coming-soon is rendered in the meantime
 * — an empty promise is worse than no promise.
 */
export const LIBRARY_CATEGORIES: {
  id: LibraryCategoryId;
  label: string;
  to: string;
}[] = [
  { id: "meetings", label: "Meetings", to: PATHS.library },
];

/** Renders nothing while Library has a single category — see above. */
export function LibraryCategoryNav({ active }: { active: LibraryCategoryId }) {
  if (LIBRARY_CATEGORIES.length < 2) return null;
  return (
    <nav
      aria-label="Library categories"
      className="mb-3 flex flex-wrap items-center gap-1"
    >
      {LIBRARY_CATEGORIES.map((category) => {
        const isActive = category.id === active;
        return (
          <Link
            key={category.id}
            to={category.to}
            aria-current={isActive ? "page" : undefined}
            className={`flex min-h-11 items-center rounded-lg px-3 text-sm font-medium transition-colors md:min-h-0 md:py-1.5 ${
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            }`}
          >
            {category.label}
          </Link>
        );
      })}
    </nav>
  );
}
