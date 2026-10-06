// The app's frame (TC-761): navigation chrome for the size class, and the
// surfaces it switches between.
//
// The fixed-tree rule. The grid always renders
//     [sidebar slot][rail slot][<main> with the surface slots][island row][tab bar slot]
// with every slot present (null when not shown), so <main> and each surface
// wrapper keep their place in the tree at every size class. Only grid classes
// change; a kept-alive subtree is never re-parented by a resize or rotation.
//
// Mounting. Chat is always mounted and hidden when another surface shows
// (streams, drafts and the open thread survive). Capture mounts on its first
// visit and is then kept, hidden (its scroll, the Library and a desktop local
// recording survive). Connectors, Settings and How it works mount only while
// shown.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router-dom";

import { cn } from "@/lib/utils";
import type { AppPlatform } from "../lib/platform";
import { useSizeClass, type SizeClassState } from "../lib/sizeClass";
import { navItems, navKindFor, type NavKind } from "./navItems";
import { NavRail } from "./NavRail";
import { noteLocation, scrollSurfaceToTop } from "./navigation";
import type { Destination, Screen } from "./routes";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { useAndroidBack } from "./useAndroidBack";
import { useKeyboardOpen } from "./useKeyboardOpen";

export interface AppShellProps {
  screen: Screen;
  platform: AppPlatform;
  /** Meetings waiting in Connectors, for its badge. */
  pendingMeetings: number;
  chat: ReactNode;
  /** Null where the surface does not exist (local validation). */
  capture: ReactNode | null;
  connectors: ReactNode | null;
  settings: ReactNode | null;
  /** How it works (/chat/about); it exists wherever Chat does. */
  about?: ReactNode | null;
  /** The minimised recorder, in its own row above the tab bar (PR4). */
  island?: ReactNode;
  /** The minimised recorder in the rail, above Settings (PR4). */
  railLive?: ReactNode;
  /** The minimised recorder in the sidebar's foot, above Settings (PR4). */
  sidebarLive?: ReactNode;
}

type Shown = Destination | "settings" | "about";

/** What fills <main>: the screen's surface, or Chat when that surface does not exist. */
export function shownSurface(
  screen: Screen,
  slots: Pick<AppShellProps, "capture" | "connectors" | "settings" | "about">,
): Shown {
  if (screen.id === "settings") return slots.settings ? "settings" : "chat";
  if (screen.id === "about") return slots.about ? "about" : "chat";
  if (screen.destination === "capture") return slots.capture ? "capture" : "chat";
  if (screen.destination === "connectors") return slots.connectors ? "connectors" : "chat";
  return "chat";
}

/** No navigation when Chat is the only surface (local validation). */
export function shellNavKind(sizeClass: SizeClassState, slots: Pick<AppShellProps, "capture" | "connectors">): NavKind | "none" {
  return slots.capture === null && slots.connectors === null ? "none" : navKindFor(sizeClass);
}

const GRID: Record<NavKind | "none", string> = {
  tabbar: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto_auto]",
  rail: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]",
  sidebar: "grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]",
  none: "grid-cols-1 grid-rows-[minmax(0,1fr)_auto]",
};

export interface AppShellViewProps extends AppShellProps {
  sizeClass: SizeClassState;
  /** Capture has been visited, so its surface stays mounted. */
  captureMounted: boolean;
  mainRef?: RefObject<HTMLElement | null>;
  onReselect?: (destination: Destination) => void;
}

/** The frame as a pure function of its props (server-rendered in the tests). */
export function AppShellView({
  screen,
  platform,
  pendingMeetings,
  chat,
  capture,
  connectors,
  settings,
  about = null,
  island = null,
  railLive = null,
  sidebarLive = null,
  sizeClass,
  captureMounted,
  mainRef,
  onReselect = () => {},
}: AppShellViewProps) {
  const nav = shellNavKind(sizeClass, { capture, connectors });
  const shown = shownSurface(screen, { capture, connectors, settings, about });
  // Settings and How it works are global: no navigation item is current.
  const globalScreen = shown === "settings" || shown === "about";
  const current: Destination | null = globalScreen ? null : shown;
  const items = navItems(pendingMeetings).filter(
    (item) => (item.id !== "capture" || capture !== null) && (item.id !== "connectors" || connectors !== null),
  );
  const navProps = { items, current, replace: platform === "ios" || platform === "android", onReselect };
  const beside = nav === "rail" || nav === "sidebar";
  const surface = (name: Shown) => (shown === name ? "h-full" : "hidden");

  return (
    <div className={cn("grid h-full min-h-0", GRID[nav])}>
      {nav === "sidebar" ? (
        <div className="row-span-2 min-h-0">
          <Sidebar {...navProps} settings={settings !== null} live={sidebarLive} />
        </div>
      ) : null}
      {nav === "rail" ? (
        <div className="row-span-2 min-h-0">
          <NavRail {...navProps} settings={settings !== null} live={railLive} />
        </div>
      ) : null}
      <main
        ref={mainRef}
        className={cn(
          "relative row-start-1 min-h-0 min-w-0 pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]",
          beside ? "col-start-2" : "col-start-1 pl-[env(safe-area-inset-left)]",
        )}
      >
        <div data-surface="chat" className={surface("chat")}>
          {chat}
        </div>
        <div data-surface="capture" className={surface("capture")}>
          {captureMounted ? capture : null}
        </div>
        <div data-surface="connectors" className={surface("connectors")}>
          {shown === "connectors" ? connectors : null}
        </div>
        <div data-surface="settings" className={surface("settings")}>
          {shown === "settings" ? settings : null}
        </div>
        <div data-surface="about" className={surface("about")}>
          {shown === "about" ? about : null}
        </div>
      </main>
      {island ? (
        <div className={cn("row-start-2 [html[data-keyboard=open]_&]:hidden", beside ? "col-start-2" : "col-start-1")}>{island}</div>
      ) : null}
      {nav === "tabbar" && !globalScreen ? (
        <div className="row-start-3">
          <TabBar {...navProps} />
        </div>
      ) : null}
    </div>
  );
}

export function AppShell(props: AppShellProps) {
  const sizeClass = useSizeClass();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const shown = shownSurface(props.screen, props);
  const nav = shellNavKind(sizeClass, props);
  const hasIsland = props.island !== undefined && props.island !== null && props.island !== false;

  // Capture mounts on its first visit and is kept from then on.
  const [captureMounted, setCaptureMounted] = useState(shown === "capture");
  if (shown === "capture" && !captureMounted) setCaptureMounted(true);

  // The bottom chrome (--tc-bottom-chrome in index.css) follows the navigation kind.
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (nav === "none") delete root.dataset.nav;
    else root.dataset.nav = nav;
    if (hasIsland) root.dataset.island = "";
    else delete root.dataset.island;
  }, [nav, hasIsland]);
  useLayoutEffect(
    () => () => {
      delete document.documentElement.dataset.nav;
      delete document.documentElement.dataset.island;
    },
    [],
  );

  useKeyboardOpen(sizeClass.size);
  useAndroidBack({ screen: props.screen, platform: props.platform });

  useEffect(() => {
    noteLocation(location.pathname);
  }, [location.pathname, location.key]);

  // After the user moves to another screen, focus its heading, so assistive
  // tech announces where they are. Never on first mount (the composer may own
  // focus), and StrictMode's second effect run sees the same screen. A surface
  // that already placed focus keeps it (How it works focuses the section a
  // link pointed at; its effect runs before this one).
  const focusedScreen = useRef(props.screen.id);
  useEffect(() => {
    if (focusedScreen.current === props.screen.id) return;
    focusedScreen.current = props.screen.id;
    const surfaceElement = mainRef.current?.querySelector(`[data-surface="${shown}"]`);
    if (surfaceElement?.contains(document.activeElement)) return;
    const headings = mainRef.current?.querySelectorAll<HTMLElement>(`[data-surface="${shown}"] h1`) ?? [];
    for (const heading of headings) {
      if (heading.getClientRects().length === 0) continue;
      heading.focus({ preventScroll: true });
      return;
    }
  }, [props.screen.id, shown]);

  return (
    <AppShellView
      {...props}
      sizeClass={sizeClass}
      captureMounted={captureMounted}
      mainRef={mainRef}
      onReselect={scrollSurfaceToTop}
    />
  );
}
