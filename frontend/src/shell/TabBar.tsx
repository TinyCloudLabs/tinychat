// The bottom tab bar, on a phone held upright (TC-761). Calm by design: chrome
// surface, one hairline, and the current tab marked by a tinted pill behind
// its icon plus a heavier label and icon stroke (never colour alone).
import type { MouseEvent } from "react";
import { Link, useLocation } from "react-router-dom";
import { UserRoundIcon } from "lucide-react";

import { PILL_LABELS } from "@/apps/strings";
import { cn } from "@/lib/utils";
import { useStorageReadOnly } from "@/lib/useStorageReadOnly";
import { NavBadge } from "./NavBadge";
import { NavLink } from "./NavLink";
import { navTarget, type NavItem, type NavItemId } from "./navItems";
import { PATHS, type Destination } from "./routes";

export interface NavProps {
  items: NavItem[];
  /** The current item; null on Settings. */
  current: NavItemId | null;
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
      <ul className="mx-auto flex min-h-14 max-w-md">
        {items.map((item) => {
          const active = item.id === current;
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex min-w-fit flex-1">
              <NavLink
                item={item}
                to={navTarget(item, active)}
                replace={replace}
                aria-current={active ? "page" : undefined}
                aria-label={item.ariaLabel}
                onClick={(event: MouseEvent) => {
                  if (!active || pathname !== item.href) return;
                  event.preventDefault();
                  onReselect(item.destination);
                }}
                className="tap-transparent group flex min-w-0 flex-1 flex-col items-center justify-center gap-1"
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
                <span className={cn("min-w-0 text-center !text-[11px] text-label [word-break:keep-all] [overflow-wrap:normal]", active ? "font-semibold text-foreground" : "font-medium text-muted-foreground")} style={{ fontSize: "min(0.6875rem,12px)", lineHeight: "min(0.875rem,14px)" }}>
                  {item.label}
                </span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export interface PillTabBarProps extends Omit<NavProps, "current"> {
  /** The current item; "you" on Settings, null where nothing is (How it works hides the pill). */
  current: NavItemId | "you" | null;
  /** You leads to Settings (null in local validation, then there is no You). */
  settings: boolean;
}

/**
 * One's new navigation (ONE_NAV_ENABLED) on a phone held upright: a glass pill floating over the page, inset from the edges and above the
 * home indicator, icon-only (each item has a spoken label). The current item sits in an inner pill. The page scrolls
 * under it: the shell sets `data-pill`, which pads every scroller by --tc-bottom-chrome (index.css).
 */
export function PillTabBar({ items, current, replace, onReselect, settings }: PillTabBarProps) {
  const { pathname } = useLocation();
  const storageFull = useStorageReadOnly();
  const onYou = current === "you";
  const itemClass = (active: boolean) =>
    cn(
      "tap-transparent relative flex h-[50px] w-[66px] items-center justify-center rounded-full transition-colors duration-150",
      active ? "bg-foreground/[.09] text-foreground" : "text-muted-foreground active:bg-foreground/[.05]",
    );
  return (
    <nav
      aria-label="Primary"
      data-testid="pill-bar"
      className="pointer-events-none flex justify-center pb-[calc(10px+env(safe-area-inset-bottom))] pl-[max(12px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))] pt-2.5 [html[data-keyboard=open]_&]:hidden"
    >
      <ul className="tc-pill pointer-events-auto flex gap-0.5 rounded-full p-1.5">
        {items.map((item) => {
          const active = item.id === current;
          const Icon = item.icon;
          return (
            <li key={item.id} className="flex">
              <Link
                to={navTarget(item, active)}
                replace={replace}
                aria-current={active ? "page" : undefined}
                aria-label={item.ariaLabel ?? item.label}
                onClick={(event: MouseEvent) => {
                  if (!active || pathname !== item.href) return;
                  event.preventDefault();
                  onReselect(item.destination);
                }}
                className={itemClass(active)}
              >
                <span className="relative">
                  <Icon aria-hidden className={cn("size-[26px]", active && "[stroke-width:2.25]")} />
                  <NavBadge count={item.badge} className="-right-3 -top-2" />
                </span>
              </Link>
            </li>
          );
        })}
        {settings ? (
          <li className="flex">
            <Link to={PATHS.settings} replace={replace} aria-label={PILL_LABELS.you} aria-current={onYou ? "page" : undefined} className={itemClass(onYou)}>
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full bg-[#2b3157] text-[#fdf9d2]",
                  onYou && "shadow-[0_0_0_2px_hsl(var(--background)),0_0_0_3.5px_hsl(var(--foreground))]",
                )}
              >
                <UserRoundIcon aria-hidden className="size-4" />
              </span>
              {storageFull && <span role="img" aria-label="Storage full" className="absolute right-3 top-2 size-2.5 rounded-full bg-destructive ring-2 ring-background" />}
            </Link>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
