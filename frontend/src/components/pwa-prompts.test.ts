import { expect, test } from "bun:test";
import { installOffered } from "./pwa-prompts";

const ready = { canInstall: true, installDismissed: false, signedIn: true };

test("the install is offered only after sign-in", () => {
  expect(installOffered({ ...ready, signedIn: false })).toBe(false);
  expect(installOffered({ ...ready, signedIn: true })).toBe(true);
});

test("nothing is offered when the browser cannot install or the visitor said not now", () => {
  expect(installOffered({ ...ready, canInstall: false })).toBe(false);
  expect(installOffered({ ...ready, installDismissed: true })).toBe(false);
});
