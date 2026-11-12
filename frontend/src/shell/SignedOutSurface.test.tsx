import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignedOutSurface } from "./SignedOutSurface";

const base = { platform: "web", state: "unauthenticated", error: null, onAction: () => {} } as const;
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;

test("a signed-out web visitor sees the front page, not the sign-in screen", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} />);
  expect(markup).toContain("Sign in to your Home");
  expect(markup).toContain('aria-label="Demo feed"');
  expect(markup).not.toContain("Sign in to continue.");
  expect(markup).not.toContain('text-title-2">TinyCloud Home</h1>');
});

test("the signed-out Home page has exactly one main landmark and one h1", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} />);
  expect(count(markup, /<main[\s>]/g)).toBe(1);
  expect(count(markup, /<\/main>/g)).toBe(1);
  expect(count(markup, /<h1[\s>]/g)).toBe(1);
});

test("the front page offers the agent prompt in the hero and moves What is TinyCloud? below the sample cards", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} />);
  const agent = markup.indexOf("Let your agent share to your TinyCloud");
  const demo = markup.indexOf('aria-label="Demo feed"');
  const learn = markup.indexOf("What is TinyCloud?");
  expect(agent).toBeGreaterThan(markup.indexOf("Sign in to your Home"));
  expect(agent).toBeLessThan(demo);
  expect(learn).toBeGreaterThan(demo);
});

test("the desktop app keeps the TinyCloud Home sign-in screen, with one main landmark", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} platform="tauri" />);
  expect(markup).toContain("Sign in to continue.");
  expect(markup).toContain(">TinyCloud Home</h1>");
  expect(markup).not.toContain('aria-label="Demo feed"');
  expect(count(markup, /<main[\s>]/g)).toBe(1);
});

test("while the session restores, the boot screen carries the Home name", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} state="booting" />);
  expect(markup).toContain("Restoring your session…");
  expect(markup).toContain(">TinyCloud Home</h1>");
});

test("the native sign-in screen replaces the page when it is shown", () => {
  const markup = renderToStaticMarkup(<SignedOutSurface {...base} native={<p>native sign-in</p>} />);
  expect(markup).toContain("native sign-in");
  expect(markup).not.toContain("Sign in to your Home");
  expect(count(markup, /<main[\s>]/g)).toBe(1);
});

test("a returning web visitor never gets the front page while offline or after an error", () => {
  for (const state of ["offline", "recoverableError"] as const) {
    const markup = renderToStaticMarkup(<SignedOutSurface {...base} state={state} error={state === "offline" ? "You're offline." : "Something went wrong."} />);
    expect(markup).not.toContain('aria-label="Demo feed"');
    expect(markup).not.toContain("Sign in to your Home");
    expect(markup).toContain(">TinyCloud Home</h1>");
    expect(markup).toContain(state === "offline" ? "Try again</button>" : "Sign in</button>");
    expect(count(markup, /<main[\s>]/g)).toBe(1);
  }
});
