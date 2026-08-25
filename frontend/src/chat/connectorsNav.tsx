// The Connectors information architecture, in one pure module.
//
//     Connectors → Sources | Library → Meetings
//
// Sources is the setup/capture half (which connectors are connected, and the
// transcriber). Library is the browsable half — the content those connectors
// have already synced. They are peer TABS of one persistent page, and each is a
// real route, so a Library link can be shared, bookmarked and reloaded.
//
// Route-driven tabs are marked up as NAVIGATION, not as ARIA `tablist`: the
// panels are addresses, not toggled regions, so `<nav>` + `<Link>` +
// `aria-current="page"` is the honest semantic and keeps browser affordances
// (open in a new tab, back) working. Same reason the sidebar entry is a nav
// control rather than a tab.
//
// Nothing here touches `tcw`, a session or storage — it is markup and a couple
// of tables, which is what makes the whole IA directly testable.

import { Link } from "react-router-dom";

/** Sources — the connector setup/capture surface, and the Connectors default. */
export const CONNECTORS_SOURCES_PATH = "/chat/connectors";
/** Library — the canonical home of everything the connectors have synced. */
export const CONNECTORS_LIBRARY_PATH = "/chat/connectors/library";

export type ConnectorsTab = "sources" | "library";

const TABS: { id: ConnectorsTab; label: string; to: string }[] = [
  { id: "sources", label: "Sources", to: CONNECTORS_SOURCES_PATH },
  { id: "library", label: "Library", to: CONNECTORS_LIBRARY_PATH },
];

/** Which tab a pathname selects. Anything that is not Library is Sources, so
 *  the bare `/chat/connectors` address keeps landing on setup. */
export function connectorsTabFor(pathname: string): ConnectorsTab {
  return pathname.endsWith("/library") ? "library" : "sources";
}

const TAB_CLASS =
  "-mb-px flex min-h-11 items-center border-b-2 px-3 text-sm font-medium transition-colors md:min-h-0 md:py-2";

export function ConnectorsTabs({ active }: { active: ConnectorsTab }) {
  return (
    <nav
      aria-label="Connectors sections"
      className="mb-4 flex items-center gap-1 border-b border-border"
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            to={tab.to}
            aria-current={isActive ? "page" : undefined}
            className={`${TAB_CLASS} ${
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

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
  { id: "meetings", label: "Meetings", to: CONNECTORS_LIBRARY_PATH },
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
