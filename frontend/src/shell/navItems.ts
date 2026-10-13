// The navigation model shared by the tab bar, the rail and the sidebar
// (TC-761): the same three destinations, in the same order, at every size.
import { AudioLinesIcon, MessageCircleIcon, PlugIcon, type LucideIcon } from "lucide-react";

import { connectorsAriaLabel } from "../chat/useBackgroundDrain";
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
    { id: "capture", label: "Capture", icon: AudioLinesIcon, href: PATHS.capture },
    { id: "chat", label: "Chat", icon: MessageCircleIcon, href: PATHS.chat },
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
