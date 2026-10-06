// The sidebar, from 1024 px (TC-761): the three destinations as full rows on
// the chrome surface, and Settings at the foot. The live recording card joins
// the foot above Settings (PR4).
import type { MouseEvent, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { SettingsIcon, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { NavBadge } from "./NavBadge";
import { tabTarget } from "./navigation";
import { PATHS } from "./routes";
import type { NavProps } from "./TabBar";

// Structural spacing in px, so scaled-up text gets the room (the sidebar itself
// widens with the text, up to 320 px).
const ROW =
  "tap-transparent group relative flex min-h-11 items-center gap-[12px] rounded-md px-[12px] text-callout transition-colors duration-150 fine:min-h-10";

function RowContent({ icon: Icon, label, active }: { icon: LucideIcon; label: string; active: boolean }) {
  return (
    <>
      <Icon aria-hidden className={cn("size-5 shrink-0", active ? "text-foreground [stroke-width:2.25]" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );
}

const rowState = (active: boolean) =>
  active
    ? "bg-selected font-semibold text-foreground"
    : "font-medium text-muted-foreground hover:bg-surface-2 hover:text-foreground active:bg-surface-2";

export function Sidebar({
  items,
  current,
  replace,
  onReselect,
  settings,
  live = null,
}: NavProps & {
  /** Settings is reachable (it is null in local validation). */
  settings: boolean;
  /** The minimised recorder's card, above Settings. */
  live?: ReactNode;
}) {
  const { pathname } = useLocation();
  const onSettings = current === null;
  return (
    <nav
      aria-label="Primary"
      data-testid="sidebar"
      className="flex h-full w-[clamp(232px,14.5rem,320px)] flex-col border-r border-border/70 bg-chrome pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[calc(12px+env(safe-area-inset-left))] pr-[12px] pt-[max(1rem,env(safe-area-inset-top))]"
    >
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const active = item.id === current;
          return (
            <li key={item.id}>
              <Link
                to={tabTarget(item.id, active)}
                replace={replace}
                aria-current={active ? "page" : undefined}
                aria-label={item.ariaLabel}
                onClick={(event: MouseEvent) => {
                  if (!active || pathname !== item.href) return;
                  event.preventDefault();
                  onReselect(item.id);
                }}
                className={cn(ROW, rowState(active), item.badge ? "pr-[40px]" : undefined)}
              >
                <RowContent icon={item.icon} label={item.label} active={active} />
                <NavBadge count={item.badge} className="right-2.5 top-1/2 -translate-y-1/2" />
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto">{live}</div>
      {settings && (
        <div className="mt-2 border-t border-border/70 pt-2">
          <Link
            to={PATHS.settings}
            aria-current={onSettings ? "page" : undefined}
            className={cn(ROW, rowState(onSettings))}
          >
            <RowContent icon={SettingsIcon} label="Settings" active={onSettings} />
          </Link>
        </div>
      )}
    </nav>
  );
}
