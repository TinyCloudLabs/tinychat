// The bottom tab bar, on a phone held upright (TC-761). Calm by design: chrome
// surface, one hairline, and the current tab marked by a tinted pill behind
// its icon plus a heavier label and icon stroke (never colour alone).
import type { MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";
import { NavBadge } from "./NavBadge";
import type { NavItem } from "./navItems";
import { tabTarget } from "./navigation";
import type { Destination } from "./routes";

export interface NavProps {
  items: NavItem[];
  /** The current destination; null on Settings. */
  current: Destination | null;
  /** Tab switches replace the address in the phone app (history holds only pushed screens). */
  replace: boolean;
  /** The current item was tapped again at its root: scroll it to the top. */
  onReselect: (destination: Destination) => void;
}

export function TabBar({ items, current, replace, onReselect }: NavProps) {
  const { pathname } = useLocation();
  return (
    <nav
      aria-label="Primary"
      data-testid="tab-bar"
      className="border-t border-border/70 bg-chrome pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] [html[data-keyboard=open]_&]:hidden"
    >
      <ul className="mx-auto grid h-14 max-w-md grid-cols-3">
        {items.map((item) => {
          const active = item.id === current;
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex">
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
                className="tap-transparent group flex flex-1 flex-col items-center justify-center gap-1"
              >
                <span
                  className={cn(
                    "relative flex h-[30px] w-[52px] items-center justify-center rounded-full transition-colors duration-150",
                    active ? "bg-selected" : "group-active:bg-surface-2",
                  )}
                >
                  <Icon aria-hidden className={cn("size-6", active ? "text-foreground [stroke-width:2.25]" : "text-muted-foreground")} />
                  <NavBadge count={item.badge} className="-right-1 -top-1" />
                </span>
                <span className={cn("text-label", active ? "font-semibold text-foreground" : "font-medium text-muted-foreground")}>
                  {item.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
