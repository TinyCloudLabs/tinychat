// The navigation model shared by the tab bar, the rail and the sidebar
// (TC-761, TC-2040): the same destinations, in the same order, at every size.
import { AppWindowIcon, AudioLinesIcon, HouseIcon, MessageCircleIcon, NewspaperIcon, PlugIcon, type LucideIcon } from "lucide-react";

import { connectorsAriaLabel } from "../chat/useBackgroundDrain";
import { HOME_SITE } from "../lib/homeSite";
import { NAV_LABEL_APPS, NAV_LABEL_CHAT, NAV_LABEL_FEED, NAV_LABEL_HOME, NAV_LABEL_RECORDING } from "../lib/homeStrings";
import { useSizeClass, type SizeClassState } from "../lib/sizeClass";
import { PATHS, type Destination } from "./routes";

/** Which navigation chrome a size class gets. */
export type NavKind = "tabbar" | "rail" | "sidebar";

/** A tab bar on a phone held upright; a rail on a phone on its side and on tablets; a sidebar from 1024 px. */
export function navKindFor({ size, land }: SizeClassState): NavKind {
  if (size === "expanded") return "sidebar";
  if (size === "medium" || land) return "rail";
  return "tabbar";
}

export function useNavKind(): NavKind {
  return navKindFor(useSizeClass());
}

export interface NavItem {
  id: Destination;
  label: string;
  icon: LucideIcon;
  /** The destination's root. */
  href: string;
  /** A count shown on the item (NavBadge). */
  badge?: number;
  /** The accessible name when it says more than the label (a count). */
  ariaLabel?: string;
}

/** `pendingMeetings`: meetings waiting in Connectors (0 while Connectors is open). */
export function navItems(pendingMeetings: number, homeSite: boolean = HOME_SITE): NavItem[] {
  const capture: NavItem = { id: "capture", label: NAV_LABEL_RECORDING, icon: AudioLinesIcon, href: PATHS.capture };
  const chat: NavItem = { id: "chat", label: NAV_LABEL_CHAT, icon: MessageCircleIcon, href: PATHS.chat };
  const apps: NavItem = { id: "apps", label: NAV_LABEL_APPS, icon: AppWindowIcon, href: PATHS.apps };
  const connectors: NavItem = {
    id: "connectors",
    label: "Connectors",
    icon: PlugIcon,
    href: PATHS.connectors,
    badge: pendingMeetings,
    ariaLabel: connectorsAriaLabel(pendingMeetings),
  };
  // The Home site (TC-2387) leads with the feed, named Home, then Chat and Apps. Recording and Connectors are always
  // there: each asks for its own permission in place when it opens.
  return homeSite
    ? [{ id: "feed", label: NAV_LABEL_HOME, icon: HouseIcon, href: PATHS.feed }, chat, apps, capture, connectors]
    : [capture, chat, apps, { id: "feed", label: NAV_LABEL_FEED, icon: NewspaperIcon, href: PATHS.feed }, connectors];
}
