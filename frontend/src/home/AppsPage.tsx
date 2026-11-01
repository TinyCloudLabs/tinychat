// The Apps destination (TC-2040): a list of links that open Share's existing
// runner in a new tab. Not embedded, and Home grants these apps nothing.
import { ExternalLinkIcon } from "lucide-react";

import {
  APPS_EMPTY,
  APPS_LIST_LABEL,
  APPS_OPEN_IN_SHARE,
  APPS_OPENS_NEW_TAB,
  APPS_PAGE_LEAD,
  APPS_PAGE_TITLE,
} from "@/lib/homeStrings";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import { SHARE_APPS, shareRunUrl, type ShareApp } from "./shareApps";

export function AppsPage({ apps = SHARE_APPS }: { apps?: readonly ShareApp[] }) {
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={APPS_PAGE_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        <p className="text-body text-muted-foreground">{APPS_PAGE_LEAD}</p>
        {apps.length === 0 ? (
          <p className="text-body text-muted-foreground">{APPS_EMPTY}</p>
        ) : (
          <ul aria-label={APPS_LIST_LABEL} className="flex flex-col gap-2">
            {apps.map((app) => (
              <li key={app.appId}>
                <a
                  href={shareRunUrl(app.appId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 flex-col gap-1 rounded-lg border bg-card p-3 hover:bg-surface-2"
                >
                  <span className="flex items-center gap-2 text-body font-semibold text-foreground">
                    {app.name}
                    <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </span>
                  <span className="text-body text-muted-foreground">{app.description}</span>
                  <span className="text-label text-primary">
                    {APPS_OPEN_IN_SHARE} <span className="sr-only">({APPS_OPENS_NEW_TAB})</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
