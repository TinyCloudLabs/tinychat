import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CONNECTORS_LIBRARY_PATH,
  CONNECTORS_SOURCES_PATH,
  DESTINATION_ROOTS,
  LEGACY_REDIRECTS,
  PATHS,
  destinationOf,
  homeDestination,
  homePath,
  isPushed,
  legacyRedirectFor,
  notePath,
  parentPath,
  redirectsWhenSignedOut,
  screenFor,
} from "./routes";
import { ABOUT_PATH, aboutHref } from "../lib/about";

describe("screenFor", () => {
  test("Chat is /chat, with or without its trailing slash", () => {
    expect(screenFor("/chat")).toEqual({ id: "chat", destination: "chat", noteId: null });
    expect(screenFor("/chat/")).toEqual({ id: "chat", destination: "chat", noteId: null });
  });

  test("Capture, its Library and a note", () => {
    expect(screenFor("/chat/capture")).toEqual({ id: "capture", destination: "capture", noteId: null });
    expect(screenFor("/chat/capture/")).toMatchObject({ id: "capture" });
    expect(screenFor("/chat/capture/library")).toEqual({ id: "library", destination: "capture", noteId: null });
    expect(screenFor("/chat/capture/library/")).toMatchObject({ id: "library" });
    expect(screenFor("/chat/capture/library/7f3a")).toEqual({ id: "note", destination: "capture", noteId: "7f3a" });
    // The id is URL-encoded in the address.
    expect(screenFor(notePath("a/b c"))).toMatchObject({ id: "note", noteId: "a/b c" });
    // Anything else under Capture is Capture.
    expect(screenFor("/chat/capture/elsewhere")).toMatchObject({ id: "capture" });
  });

  test("Connectors spans its subtree; Settings is global", () => {
    expect(screenFor("/chat/connectors")).toEqual({ id: "connectors", destination: "connectors", noteId: null });
    expect(screenFor("/chat/connectors/")).toMatchObject({ id: "connectors" });
    expect(screenFor("/chat/settings")).toEqual({ id: "settings", destination: null, noteId: null });
    expect(screenFor("/chat/settings/")).toMatchObject({ id: "settings" });
  });

  test("How it works is /chat/about: global, like Settings, and its section anchors don't change the screen", () => {
    expect(PATHS.about).toBe("/chat/about");
    expect(PATHS.about).toBe(ABOUT_PATH);
    expect(screenFor("/chat/about")).toEqual({ id: "about", destination: null, noteId: null });
    expect(screenFor("/chat/about/")).toMatchObject({ id: "about" });
    // The hash is not part of the pathname the shell reads.
    expect(screenFor(new URL(aboutHref("connectors"), "https://exo.test").pathname)).toMatchObject({ id: "about" });
    expect(legacyRedirectFor("/chat/about")).toBeUndefined();
  });

  test("an unknown /chat/* address is the chat workspace", () => {
    expect(screenFor("/chat/foo")).toMatchObject({ id: "chat", destination: "chat" });
    expect(screenFor("/chat/thread-123")).toMatchObject({ id: "chat" });
  });

  test("a legacy address shows the screen it forwards to", () => {
    expect(screenFor("/chat/meetings")).toMatchObject({ id: "library", destination: "capture" });
    expect(screenFor("/chat/connectors/library")).toMatchObject({ id: "library", destination: "capture" });
    expect(screenFor("/chat/connectors/library/")).toMatchObject({ id: "library" });
  });

  test("every destination root maps back to its destination", () => {
    for (const [destination, root] of Object.entries(DESTINATION_ROOTS)) {
      expect(destinationOf(screenFor(root))).toBe(destination as keyof typeof DESTINATION_ROOTS);
    }
    expect(PATHS.connectors).toBe("/chat/connectors");
    expect(PATHS.capture).toBe("/chat/capture");
    expect(PATHS.library).toBe("/chat/capture/library");
  });
});

describe("legacy addresses", () => {
  test("/chat/meetings and /chat/connectors/library forward to the Library", () => {
    expect(LEGACY_REDIRECTS).toEqual([
      { from: "/chat/connectors/library", to: PATHS.library },
      { from: "/chat/meetings", to: PATHS.library },
    ]);
    expect(legacyRedirectFor("/chat/meetings")?.to).toBe(PATHS.library);
    expect(legacyRedirectFor("/chat/meetings/")?.to).toBe(PATHS.library);
    expect(legacyRedirectFor("/chat/connectors/library")?.to).toBe(PATHS.library);
    expect(legacyRedirectFor("/chat/connectors")).toBeUndefined();
    expect(legacyRedirectFor("/chat/capture/library")).toBeUndefined();
  });
});

describe("pushed screens and their parents", () => {
  const at = (path: string) => screenFor(path);

  test("Settings, How it works, the Library and a note are pushed; destination roots are not", () => {
    for (const size of ["compact", "medium", "expanded"] as const) {
      expect(isPushed(at(PATHS.settings), size)).toBe(true);
      expect(isPushed(at(PATHS.about), size)).toBe(true);
      expect(isPushed(at(PATHS.library), size)).toBe(true);
      expect(isPushed(at(notePath("x")), size)).toBe(true);
      expect(isPushed(at(PATHS.capture), size)).toBe(false);
      expect(isPushed(at(PATHS.chat), size)).toBe(false);
      expect(isPushed(at(PATHS.connectors), size)).toBe(false);
    }
  });

  test("Back goes up: a note to the Library, the Library to Capture, Settings and How it works home", () => {
    expect(parentPath(at(notePath("x")))).toBe(PATHS.library);
    expect(parentPath(at(PATHS.library))).toBe(PATHS.capture);
    expect(parentPath(at(PATHS.settings))).toBeNull();
    expect(parentPath(at(PATHS.about))).toBeNull();
  });
});

describe("home", () => {
  test("the phone app opens on Capture; the desktop app, the web and the PWA on Chat", () => {
    expect(homeDestination("ios")).toBe("capture");
    expect(homeDestination("android")).toBe("capture");
    expect(homePath("ios")).toBe("/chat/capture");
    expect(homeDestination("tauri")).toBe("chat");
    expect(homeDestination("web")).toBe("chat");
    expect(homePath("web")).toBe("/chat");
  });
});

// Moved from connectorsNav.test.tsx with the constants (TC-761, PR6).
describe("the old Connectors addresses", () => {
  test("are kept as constants, and the Library one forwards to Capture → Library", () => {
    expect(CONNECTORS_SOURCES_PATH).toBe(PATHS.connectors);
    expect(CONNECTORS_LIBRARY_PATH).toBe("/chat/connectors/library");
    expect(legacyRedirectFor(CONNECTORS_LIBRARY_PATH)?.to).toBe(PATHS.library);
  });
});

describe("signed out", () => {
  test("Settings and Connectors send a settled signed-out user home; Capture and Chat never redirect", () => {
    expect(redirectsWhenSignedOut(screenFor(PATHS.settings))).toBe(true);
    expect(redirectsWhenSignedOut(screenFor(PATHS.connectors))).toBe(true);
    expect(redirectsWhenSignedOut(screenFor(PATHS.capture))).toBe(false);
    expect(redirectsWhenSignedOut(screenFor(PATHS.library))).toBe(false);
    expect(redirectsWhenSignedOut(screenFor(notePath("x")))).toBe(false);
    expect(redirectsWhenSignedOut(screenFor(PATHS.chat))).toBe(false);
    // How it works holds no account data: it keeps its address through sign-in.
    expect(redirectsWhenSignedOut(screenFor(PATHS.about))).toBe(false);
  });
});

// App.tsx pulls in DOM-only SDKs at module load, so its wiring is asserted
// against the source.
describe("App routes through shell/routes.ts", () => {
  const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

  test("the screen comes from the pathname; no address is rebuilt by hand", () => {
    expect(app).toContain("screenFor(location.pathname)");
    expect(app).not.toContain('location.pathname.endsWith("/chat/settings")');
    expect(app).not.toContain('location.pathname.endsWith("/chat/meetings")');
    expect(app).not.toContain("connectorsTabFor");
    // The recorder's Open (receipt and island) goes to the Library until note detail lands.
    expect(app).toContain("onOpenNote={() => navigate(PATHS.library)}");
  });

  test("How it works is mounted in the shell's about slot, with the same Back as Settings", () => {
    expect(app).toContain("about={<AboutPage onBack={onBack} />}");
  });

  test("legacy addresses forward through LEGACY_REDIRECTS, with replace, once sign-in has settled", () => {
    expect(app).toContain("const legacy = legacyRedirectFor(location.pathname);");
    const forward = app.slice(app.indexOf("if (!legacy) return;"));
    const body = forward.slice(0, forward.indexOf("}, ["));
    expect(body).toContain("if (!isReady && !authSettledSignedOut) return;");
    expect(body).toContain("navigate(isReady ? legacy.to : homePath(platform)");
    expect(body).toContain("replace: true");
    const routes = readFileSync(join(import.meta.dir, "routes.ts"), "utf8");
    expect(routes).toContain("LEGACY_REDIRECTS.find(");
  });
});
