import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WEBVIEW_UPDATE_LINK, WEBVIEW_UPDATE_MESSAGE } from "../lib/authErrors";
import { BootSurface } from "./BootSurface";

test("ordinary signed-out screen keeps its default message", () => {
  const markup = renderToStaticMarkup(<BootSurface state="unauthenticated" error={null} onAction={() => {}} />);
  expect(markup).toContain("Sign in to continue.");
  expect(markup).toContain("<h1");
  expect(markup).toContain(">Exo</h1>");
  expect(markup).not.toContain("TinyCloud Chat");
});

test("a failed sign-in or a local sign-out offers Sign in, never Try again", () => {
  for (const error of ["Couldn't sign in. Please try again.", "OpenKey stayed signed in on this device. Exo is signed out locally.", "Signed out of Exo. To use a different account, also sign out at openkey.so."]) {
    const markup = renderToStaticMarkup(<BootSurface state="recoverableError" error={error} onAction={() => {}} />);
    expect(markup).toContain(">Sign in</button>");
    expect(markup).not.toContain("Try again</button>");
  }
});

test("an offline restore still says Try again", () => {
  const markup = renderToStaticMarkup(<BootSurface state="offline" error={null} onAction={() => {}} />);
  expect(markup).toContain(">Try again</button>");
});

test("the old WebView message carries a link to update it", () => {
  const markup = renderToStaticMarkup(<BootSurface state="recoverableError" error={WEBVIEW_UPDATE_MESSAGE} onAction={() => {}} />);
  expect(markup).toContain(WEBVIEW_UPDATE_MESSAGE);
  expect(markup).toContain(`href="${WEBVIEW_UPDATE_LINK.href}"`);
  expect(markup).toContain(WEBVIEW_UPDATE_LINK.label);
});

test("an ordinary error shows no link", () => {
  const markup = renderToStaticMarkup(<BootSurface state="recoverableError" error="Couldn't sign in. Please try again." onAction={() => {}} />);
  expect(markup).not.toContain("<a ");
});
