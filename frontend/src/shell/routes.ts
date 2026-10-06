// Exo's addresses, in one pure module (TC-761).
//
//     Capture  /chat/capture → Library /chat/capture/library → a note /chat/capture/library/:id
//     Chat     /chat
//     Connectors /chat/connectors
//     Settings /chat/settings (global, behind the gear)
//     How it works /chat/about (global, from Settings and the screens' hints)
//
// The App stays mounted at /chat/* and reads which screen to show from the
// pathname, so tab switches toggle visibility instead of swapping routes (the
// chat runtime, drafts and streams survive). Nothing here touches a session or
// storage, which is what makes the whole map directly testable.

import { ABOUT_PATH } from "../lib/about";
import type { AppPlatform } from "../lib/platform";
import type { SizeClass } from "../lib/sizeClass";

export const PATHS = {
  chat: "/chat",
  capture: "/chat/capture",
  library: "/chat/capture/library",
  connectors: "/chat/connectors",
  settings: "/chat/settings",
  about: ABOUT_PATH,
} as const;

/** The three places the navigation leads to, at every size. Settings is global, not one of them. */
export type Destination = "capture" | "chat" | "connectors";

export type ScreenId = "chat" | "capture" | "library" | "note" | "connectors" | "settings" | "about";

export interface Screen {
  id: ScreenId;
  /** Which navigation item is current; null on Settings and How it works. */
  destination: Destination | null;
  /** The `connector_meeting.id` of an open note (decoded), else null. */
  noteId: string | null;
}

/** The address of one note in the Library (the id is URL-encoded). */
export function notePath(id: string): string {
  return `${PATHS.library}/${encodeURIComponent(id)}`;
}

/**
 * Retired addresses and where they live now. Each one holds its address until
 * sign-in settles, then forwards with `replace` (App), so Back never bounces
 * through it.
 */
export const LEGACY_REDIRECTS: ReadonlyArray<{ from: string; to: string }> = [
  // Library was a Connectors tab before Capture existed.
  { from: "/chat/connectors/library", to: PATHS.library },
  // The standalone Meetings page, retired before that.
  { from: "/chat/meetings", to: PATHS.library },
];

const trim = (pathname: string) => (pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname);

/** The retired address `pathname` is, if any (trailing slash included). */
export function legacyRedirectFor(pathname: string): { from: string; to: string } | undefined {
  const path = trim(pathname);
  return LEGACY_REDIRECTS.find((legacy) => legacy.from === path);
}

/**
 * The screen a pathname shows. Anything under /chat that is not a known screen
 * is the chat workspace (it was before Capture existed). A legacy address shows
 * the screen it forwards to while it waits for sign-in to settle.
 */
export function screenFor(pathname: string): Screen {
  const legacy = legacyRedirectFor(pathname);
  const path = legacy ? legacy.to : trim(pathname);
  if (path === PATHS.settings) return { id: "settings", destination: null, noteId: null };
  if (path === PATHS.about) return { id: "about", destination: null, noteId: null };
  if (path === PATHS.connectors || path.startsWith(`${PATHS.connectors}/`)) {
    return { id: "connectors", destination: "connectors", noteId: null };
  }
  if (path.startsWith(`${PATHS.library}/`)) {
    const raw = path.slice(PATHS.library.length + 1);
    let noteId: string;
    try {
      noteId = decodeURIComponent(raw);
    } catch {
      noteId = raw;
    }
    return { id: "note", destination: "capture", noteId };
  }
  if (path === PATHS.library) return { id: "library", destination: "capture", noteId: null };
  if (path === PATHS.capture || path.startsWith(`${PATHS.capture}/`)) {
    return { id: "capture", destination: "capture", noteId: null };
  }
  return { id: "chat", destination: "chat", noteId: null };
}

export function destinationOf(screen: Screen): Destination | null {
  return screen.destination;
}

/** Each destination's root address. */
export const DESTINATION_ROOTS: Readonly<Record<Destination, string>> = {
  capture: PATHS.capture,
  chat: PATHS.chat,
  connectors: PATHS.connectors,
};

/**
 * Whether a screen is stacked over a root, so Back returns to its parent.
 * Settings and How it works are pushed at every size. The Library (and a note, which shows the
 * Library until note detail arrives) is pushed at every size for now; on wide
 * screens it becomes a pane beside Capture once the list and detail panes land
 * (PR6), which is why the size class is part of the question.
 */
export function isPushed(screen: Screen, _size: SizeClass): boolean {
  return screen.id === "settings" || screen.id === "about" || screen.id === "library" || screen.id === "note";
}

/** Where Back goes from a pushed screen with no history; null means the home path (Settings, How it works). */
export function parentPath(screen: Screen): string | null {
  if (screen.id === "note") return PATHS.library;
  if (screen.id === "library") return PATHS.capture;
  if (screen.id === "settings" || screen.id === "about") return null;
  return screen.destination ? DESTINATION_ROOTS[screen.destination] : null;
}

/** The phone app opens on Capture; the desktop app, the web and the PWA on Chat. */
export function homeDestination(platform: AppPlatform): Destination {
  return platform === "ios" || platform === "android" ? "capture" : "chat";
}

export function homePath(platform: AppPlatform): string {
  return DESTINATION_ROOTS[homeDestination(platform)];
}

/**
 * Whether a screen sends a settled signed-out user home. Settings and
 * Connectors only exist signed in. Capture never redirects: the sign-in surface
 * renders in place, so the phone app lands on Capture after signing in and a
 * note's address survives a cold sign-in. How it works holds no account data,
 * so it keeps its address the same way and shows once the user signs in.
 */
export function redirectsWhenSignedOut(screen: Screen): boolean {
  return screen.id === "settings" || screen.id === "connectors";
}
