// RED-first: a cold reload of a private surface must survive session
// restoration.
//
// /chat/connectors, /chat/connectors/library and /chat/settings are real
// addresses now — shareable, bookmarkable, reloadable. On a cold load with a
// valid persisted session the App starts in `booting` and only flips to
// `ready` after restoreTinyCloudWebSession resolves, so a guard keyed on
// `!isReady` fires DURING restoration and redirects the requested pathname
// away to /chat before it ever had a chance to render. That also defeats the
// legacy /chat/meetings forward, which lands on /chat instead of Library.
//
// The rule these tests pin: only a SETTLED signed-out authentication may
// redirect a private surface. Every in-progress state preserves the pathname.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { isAuthSettledSignedOut } from "./authRouting";

describe("isAuthSettledSignedOut", () => {
  test("authentication in progress never counts as signed out", () => {
    // `booting` is the cold-reload session-restoration window — the exact
    // state the QA repro sits in when the redirect fires today.
    expect(isAuthSettledSignedOut("booting")).toBe(false);
    // The interactive sign-in handshake is equally nonterminal.
    expect(isAuthSettledSignedOut("connecting")).toBe(false);
    expect(isAuthSettledSignedOut("signing")).toBe(false);
  });

  test("an authorized session is not signed out", () => {
    expect(isAuthSettledSignedOut("ready")).toBe(false);
  });

  test("a held session waiting for the network is not signed out (TC-514)", () => {
    // An offline cold launch of /chat/connectors must still land there once
    // the restore succeeds, not on /chat.
    expect(isAuthSettledSignedOut("offline")).toBe(false);
  });

  test("settled without an authorized session is signed out", () => {
    // No/expired persisted session, a failed restore that cleared it, or a
    // sign-out flip. Both states render the sign-in button, so both are
    // terminal answers and both must protect the private surfaces.
    expect(isAuthSettledSignedOut("unauthenticated")).toBe(true);
    expect(isAuthSettledSignedOut("recoverableError")).toBe(true);
  });
});

describe("App wires the private-surface guard to the settled state", () => {
  const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

  test("the guard no longer conflates booting with signed out", () => {
    expect(app).not.toContain("if (!isReady && (showSettings || showConnectors))");
    // Which screens redirect is shell/routes.ts's rule (Settings and
    // Connectors; never Capture); where they go is the platform's home.
    expect(app).toContain("if (authSettledSignedOut && redirectsWhenSignedOut(screen))");
    const guard = app.slice(app.indexOf("if (authSettledSignedOut && redirectsWhenSignedOut(screen))"));
    expect(guard.slice(0, guard.indexOf("}, ["))).toContain("navigate(homePath(platform), { replace: true });");
    expect(app).toContain("isAuthSettledSignedOut(state)");
  });

  test("a legacy address forwards only once authentication settles", () => {
    const forward = app.slice(app.indexOf("if (!legacy) return;"));
    const body = forward.slice(0, forward.indexOf("}, ["));
    // Nonterminal → hold the address so restoration can finish and Library
    // can be reached; settled → the existing ready/signed-out split.
    expect(body).toContain("if (!isReady && !authSettledSignedOut) return;");
    expect(body).toContain("navigate(isReady ? legacy.to : homePath(platform)");
    expect(body).toContain("replace: true");
  });
});
