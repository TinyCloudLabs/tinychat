import { expect, test } from "bun:test";
import { installOffered } from "./pwa-prompts";

const ready = { canInstall: true, installDismissed: false, signedIn: true };

test("the Home site offers the install only after sign-in", () => {
  expect(installOffered({ ...ready, homeSite: true, signedIn: false })).toBe(false);
  expect(installOffered({ ...ready, homeSite: true, signedIn: true })).toBe(true);
});

test("other builds keep offering it signed out", () => {
  expect(installOffered({ ...ready, homeSite: false, signedIn: false })).toBe(true);
});

test("nothing is offered when the browser cannot install or the visitor said not now", () => {
  expect(installOffered({ ...ready, homeSite: true, canInstall: false })).toBe(false);
  expect(installOffered({ ...ready, homeSite: true, installDismissed: true })).toBe(false);
  expect(installOffered({ ...ready, homeSite: false, installDismissed: true })).toBe(false);
});
