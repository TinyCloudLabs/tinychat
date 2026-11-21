// The navigation model shared by the tab bar, the rail and the sidebar
// (TC-761, TC-2040): the same destinations, in the same order, at every size.
import { AppWindowIcon, AudioLinesIcon, HouseIcon, LayoutGridIcon, MessageCircleIcon, PlugIcon } from "lucide-react";

import { connectorsAriaLabel } from "../chat/useBackgroundDrain";
import { NAV_LABEL_APPS, NAV_LABEL_CHAT, NAV_LABEL_HOME, NAV_LABEL_RECORDING } from "../lib/homeStrings";
import { useSizeClass, type SizeClassState } from "../lib/sizeClass";
import { GLYPH_ICONS, type AppIcon } from "@/apps/icons";
import type { AppTarget } from "@/apps/registry";
import { MAIN_TAB_LABEL, PILL_LABELS } from "@/apps/strings";
import { tabTarget } from "./navigation";
import { appIdOfPin, appPinId, type PinId } from "./navPins";
import { PATHS, type Destination, type Screen } from "./routes";

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

/** A navigation item: a destination, or a pinned TinyCloud app (`app:<appId>`). */
export type NavItemId = Destination | `app:${string}`;

export interface NavItem {
  id: NavItemId;
  /** The destination whose surface the item shows (a pinned app lives in Apps). */
  destination: Destination;
  /** The item always opens `href`, never where it was left. */
  fixed?: boolean;
  /** Opens this address in a new tab (noopener, noreferrer) instead of routing. */
  newTab?: string;
  label: string;
  icon: AppIcon;
  /** The destination's root. */
  href: string;
  /** A count shown on the item (NavBadge). */
  badge?: number;
  /** The accessible name when it says more than the label (a count). */
  ariaLabel?: string;
}

/** A TinyCloud app as the navigation needs it. */
export interface NavApp {
  id: string;
  name: string;
  icon?: AppIcon;
  /** Where the app opens (the registry's appTarget): One's route, or its own page in a new tab. */
  target: AppTarget;
}

/** One Apps: the pins in order and the apps they may name. Absent, the navigation is today's. */
export interface NavPinOptions {
  pins: readonly PinId[];
  apps: readonly NavApp[];
  /** One's new navigation: the first item is named MAIN_TAB_LABEL, and pinned Recording and Connectors show their glyphs. */
  oneNav?: boolean;
}

/** The tab bar holds the three defaults and the first two pins. */
export const TAB_BAR_MAX = 5;

/** `pendingMeetings`: meetings waiting in Connectors (0 while Connectors is open). */
export function navItems(pendingMeetings: number, options?: NavPinOptions): NavItem[] {
  const connectors: NavItem = {
    id: "connectors",
    destination: "connectors",
    label: "Connectors",
    icon: PlugIcon,
    href: PATHS.connectors,
    badge: pendingMeetings,
    ariaLabel: connectorsAriaLabel(pendingMeetings),
  };
  const capture: NavItem = { id: "capture", destination: "capture", label: NAV_LABEL_RECORDING, icon: AudioLinesIcon, href: PATHS.capture };
  const feed: NavItem = { id: "feed", destination: "feed", label: NAV_LABEL_HOME, icon: HouseIcon, href: PATHS.feed };
  const chat: NavItem = { id: "chat", destination: "chat", label: NAV_LABEL_CHAT, icon: MessageCircleIcon, href: PATHS.chat };
  const apps: NavItem = { id: "apps", destination: "apps", label: NAV_LABEL_APPS, icon: AppWindowIcon, href: PATHS.apps };
  if (!options) {
    // Home leads with the feed, named Home, then Chat, Apps, Recording and Connectors, on every platform.
    return [feed, chat, apps, capture, connectors];
  }
  // One Apps: Feed, Chat and Apps always; then what the user pinned, in pin order.
  const items: NavItem[] = [options.oneNav ? { ...feed, label: MAIN_TAB_LABEL } : feed, chat, { ...apps, fixed: true }];
  for (const pin of options.pins) {
    if (pin === "capture") items.push(options.oneNav ? { ...capture, icon: GLYPH_ICONS.recording } : capture);
    else if (pin === "connectors") items.push(options.oneNav ? { ...connectors, icon: GLYPH_ICONS.connectors } : connectors);
    else {
      const appId = appIdOfPin(pin);
      const app = appId === null ? undefined : options.apps.find((candidate) => candidate.id === appId);
      if (app) {
        const newTab = app.target.kind === "newTab" ? app.target.url : undefined;
        items.push({
          id: appPinId(app.id),
          destination: "apps",
          fixed: true,
          label: app.name,
          icon: app.icon ?? AppWindowIcon,
          href: app.target.kind === "newTab" ? app.target.url : app.target.path,
          newTab,
        });
      }
    }
  }
  return items;
}

/** The items a tab bar shows. */
export const tabBarItems = (items: readonly NavItem[]): NavItem[] => items.slice(0, TAB_BAR_MAX);

/**
 * One's new navigation (ONE_NAV_ENABLED), the phone's pill: the main tab, Chat and Apps, icon-only (You, which opens Settings, follows them). No pins:
 * those live in the launcher. Apps carries Connectors' waiting meetings.
 */
export function pillItems(pendingMeetings: number): NavItem[] {
  return [
    { id: "feed", destination: "feed", label: MAIN_TAB_LABEL, icon: HouseIcon, href: PATHS.feed },
    { id: "chat", destination: "chat", label: PILL_LABELS.chat, icon: MessageCircleIcon, href: PATHS.chat },
    {
      id: "apps",
      destination: "apps",
      fixed: true,
      label: PILL_LABELS.apps,
      icon: LayoutGridIcon,
      href: PATHS.apps,
      badge: pendingMeetings,
      ariaLabel: pendingMeetings > 0 ? `${PILL_LABELS.apps}, ${connectorsAriaLabel(pendingMeetings)}` : undefined,
    },
  ];
}

/** The pill's current item: You on Settings, and Apps for every app and the Add an app page (Recording and Connectors too). */
export function pillCurrent(shown: Destination | "settings" | "about"): NavItemId | "you" | null {
  if (shown === "settings") return "you";
  if (shown === "about") return null;
  return shown === "feed" || shown === "chat" ? shown : "apps";
}

/** Which item is current. A pinned app is current on its own screen; Apps is current on any other app screen. */
export function currentItemId(destination: Destination | null, screen: Screen & { appId?: string }, items: readonly NavItem[]): NavItemId | null {
  if (destination === "apps" && screen.appId !== undefined) {
    const pinned = appPinId(screen.appId);
    if (items.some((item) => item.id === pinned)) return pinned;
  }
  return destination;
}

/** Where tapping an item leads: where it was left, or its own root for Apps and pinned apps. */
export function navTarget(item: NavItem, current: boolean): string {
  return item.fixed ? item.href : tabTarget(item.destination, current);
}
