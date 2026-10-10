import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { NATIVE_SESSION_ENDED_MESSAGE } from "../lib/openkeyNativeRenewal";
import { BootSurface } from "./BootSurface";

const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

function signedOutSurface(error: string | null) {
  let signInAttempts = 0;
  const onAction = () => { signInAttempts++; };
  const surface = BootSurface({ state: "unauthenticated", error, onAction });
  const markup = renderToStaticMarkup(surface);

  function findSignIn(node: ReactNode): (() => void) | undefined {
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
    if (node.type === Button && node.props.children === "Sign in") return node.props.onClick;
    for (const child of Children.toArray(node.props.children)) {
      const action = findSignIn(child);
      if (action) return action;
    }
  }

  expect(markup).toContain(NATIVE_SESSION_ENDED_MESSAGE);
  expect(markup).toContain(">Sign in</button>");
  findSignIn(surface)?.();
  expect(signInAttempts).toBe(1);
}

test("live terminal renewal shows the session-ended message with working Sign in", () => {
  const terminal = app.slice(app.indexOf("onTerminal: (message) =>"), app.indexOf("onStorage: () =>"));
  expect(terminal).toContain("signOutRef.current?.({ terminal: message })");
  const signOut = app.slice(app.indexOf("const signOut = useCallback"), app.indexOf("const isReady"));
  expect(signOut).toContain("completeLocalSignOut(openKeyWarning, Boolean(options.terminal))");
  const completion = app.slice(app.indexOf("const completeLocalSignOut ="), app.indexOf("useEffect(() => registerSessionSignedOutHook"));
  expect(completion).toContain("sessionStoreRef.current.clear()");
  expect(completion).toContain('terminal ? "unauthenticated"');
  expect(app).toMatch(/const signIn = useCallback\(async \(\) => \{\s+setError\(null\);/);
  expect(app).toContain('const authAction = state === "offline" ? restoreSession : signIn;');
  signedOutSurface(NATIVE_SESSION_ENDED_MESSAGE);
});

test("terminal boot restore shows the session-ended message with working Sign in", () => {
  const terminal = app.slice(app.indexOf('if (boot.kind === "terminal" || wasNative)'),
    app.indexOf("const restored = await restorePersistedSession"));
  const beforeClear = app.slice(app.indexOf('if (boot.kind === "terminal" || wasNative)'),
    app.indexOf("sessionStoreRef.current.clear()", app.indexOf('if (boot.kind === "terminal" || wasNative)')));
  expect(beforeClear).toContain("await captureHandoff()");
  expect(beforeClear.indexOf("await captureHandoff()")).toBeLessThan(beforeClear.indexOf("await boot.revoke()"));
  expect(beforeClear).toContain('if (!await captureHandoff()) { setState("recoverableError"); return; }');
  expect(beforeClear.indexOf("await captureHandoff()")).toBeLessThan(beforeClear.indexOf("clearPersistedSession(storedAddress)"));
  expect(terminal).toContain('if (boot.kind === "terminal") setError(NATIVE_SESSION_ENDED_MESSAGE)');
  expect(terminal).toContain('setState("unauthenticated")');
  expect(app).toMatch(/const signIn = useCallback\(async \(\) => \{\s+setError\(null\);/);
  expect(app).toContain('const authAction = state === "offline" ? restoreSession : signIn;');
  signedOutSurface(NATIVE_SESSION_ENDED_MESSAGE);
});

test("native restore never hands capture off for a live, offline, or recoverable session", () => {
  const boot = app.slice(app.indexOf("const boot = await restoreNativeAtBoot"),
    app.indexOf('if (boot.kind === "terminal" || wasNative)'));
  expect(boot).toContain('boot.kind === "restored"');
  expect(boot).toContain('boot.kind === "unavailable"');
  expect(boot).toContain('setState("offline")');
  expect(boot).toContain('setState("recoverableError")');
  expect(boot).not.toContain("captureHandoff()");
});

test("ordinary signed-out screen keeps its default message", () => {
  const markup = renderToStaticMarkup(<BootSurface state="unauthenticated" error={null} onAction={() => {}} />);
  expect(markup).toContain("Sign in to start chatting.");
});
