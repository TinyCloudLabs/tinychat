// The navigation model shared by the tab bar, the rail and the sidebar
// (TC-761, TC-2040): the same destinations, in the same order, at every size.
import { AppWindowIcon, AudioLinesIcon, MessageCircleIcon, NewspaperIcon, PlugIcon, type LucideIcon } from "lucide-react";

import { connectorsAriaLabel } from "../chat/useBackgroundDrain";
import { NAV_LABEL_APPS, NAV_LABEL_CHAT, NAV_LABEL_FEED, NAV_LABEL_RECORDING } from "../lib/homeStrings";
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
export function navItems(pendingMeetings: number): NavItem[] {
  return [
    { id: "capture", label: NAV_LABEL_RECORDING, icon: AudioLinesIcon, href: PATHS.capture },
    { id: "chat", label: NAV_LABEL_CHAT, icon: MessageCircleIcon, href: PATHS.chat },
    { id: "apps", label: NAV_LABEL_APPS, icon: AppWindowIcon, href: PATHS.apps },
    { id: "feed", label: NAV_LABEL_FEED, icon: NewspaperIcon, href: PATHS.feed },
    {
      id: "connectors",
      label: "Connectors",
      icon: PlugIcon,
      href: PATHS.connectors,
      badge: pendingMeetings,
      ariaLabel: connectorsAriaLabel(pendingMeetings),
    },
  ];
}
