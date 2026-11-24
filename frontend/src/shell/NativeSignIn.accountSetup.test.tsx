import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ACCOUNT_SETUP_BUTTON_LABEL, ACCOUNT_SETUP_MESSAGE, ACCOUNT_SETUP_URL } from "@/lib/accountSetup";
import { BootSurface } from "./BootSurface";
import { NativeSignIn } from "./NativeSignIn";

const link = `<a href="${ACCOUNT_SETUP_URL}"`;

test("the native sign-in screen shows the account-setup message and the button that opens tinycloud.one", () => {
  const html = renderToStaticMarkup(<NativeSignIn state="recoverableError" error={ACCOUNT_SETUP_MESSAGE} onSignIn={() => {}} />);
  expect(html).toContain("There&#x27;s no TinyCloud account for this sign-in. Create one at tinycloud.one, then come back here and sign in.");
  expect(html).toContain(link);
  expect(html).toContain(`${ACCOUNT_SETUP_BUTTON_LABEL}</a>`);
});

test("the boot screen, where a sign-in started outside the sign-in screen fails, shows the same", () => {
  const html = renderToStaticMarkup(<BootSurface state="recoverableError" error={ACCOUNT_SETUP_MESSAGE} onAction={() => {}} />);
  expect(html).toContain(link);
  expect(html).toContain(`${ACCOUNT_SETUP_BUTTON_LABEL}</a>`);
});

test("an ordinary sign-in failure has no such button", () => {
  const html = renderToStaticMarkup(<NativeSignIn state="recoverableError" error="Couldn't sign in. Try again." onSignIn={() => {}} />);
  expect(html).not.toContain(ACCOUNT_SETUP_BUTTON_LABEL);
});
