// The navigation rail, on a phone on its side and on tablets (TC-761): the same
// three destinations as the tab bar down the leading edge, and Settings at the
// foot. The minimised recorder joins it above the gear (PR4).
import type { MouseEvent, ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { SettingsIcon } from "lucide-react";

import { CaptureDot } from "@/capture/recorder/final/CaptureDot";
import { cn } from "@/lib/utils";
import { NavBadge } from "./NavBadge";
import { tabTarget } from "./navigation";
import { PATHS } from "./routes";
import type { NavProps } from "./TabBar";

export function NavRail({
  items,
  current,
  replace,
  onReselect,
  settings,
  live = null,
}: NavProps & {
  /** Settings is reachable (it is null in local validation). */
  settings: boolean;
  /** The minimised recorder, above Settings. */
  live?: ReactNode;
}) {
  const { pathname } = useLocation();
  const onSettings = current === null;
  return (
    <nav
      aria-label="Primary"
      data-testid="nav-rail"
      className="flex h-full w-[calc(64px+env(safe-area-inset-left))] flex-col items-center border-r border-border/70 bg-chrome pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pt-[max(0.75rem,env(safe-area-inset-top))] medium:w-[72px]"
    >
      <ul className="flex w-full flex-col items-center gap-1">
        {items.map((item) => {
          const active = item.id === current;
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex w-full">
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
                className="tap-transparent group flex min-h-14 flex-1 flex-col items-center justify-center gap-1 py-1"
              >
                <span
                  className={cn(
                    "relative flex h-[30px] w-[52px] items-center justify-center rounded-full transition-colors duration-150",
                    active ? "bg-selected" : "group-hover:bg-surface-2 group-active:bg-surface-2",
                  )}
                >
                  <Icon aria-hidden className={cn("size-6", active ? "text-foreground [stroke-width:2.25]" : "text-muted-foreground")} />
                  <NavBadge count={item.badge} className="-right-1 -top-1" />
                  {item.id === "capture" && <CaptureDot />}
                </span>
                <span className={cn("text-label", active ? "font-semibold text-foreground" : "font-medium text-muted-foreground")}>
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto flex flex-col items-center gap-1">
        {live}
        {settings && (
          <Link
            to={PATHS.settings}
            aria-label="Settings"
            aria-current={onSettings ? "page" : undefined}
            className="tap-transparent group flex size-12 items-center justify-center"
          >
            <span
              className={cn(
                "flex size-11 items-center justify-center rounded-full transition-colors duration-150",
                onSettings ? "bg-selected" : "group-hover:bg-surface-2 group-active:bg-surface-2",
              )}
            >
              <SettingsIcon
                aria-hidden
                className={cn("size-6", onSettings ? "text-foreground [stroke-width:2.25]" : "text-muted-foreground")}
              />
            </span>
          </Link>
        )}
      </div>
    </nav>
  );
}
