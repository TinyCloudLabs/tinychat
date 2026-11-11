// The Home site's signed-out page links to the feed lab only in a lab build. Run by src/feed/FeedLab.test.tsx
// in its own process, once with VITE_FEED_LAB=true and once without.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { HomeWelcome } from "@/home/HomeWelcome";
import { WELCOME_DEMO_NOTE } from "@/lib/homeStrings";

const LAB = process.env.VITE_FEED_LAB === "true";

test("the demo note ends with a plain link to the feed lab in a lab build, and is as it was in every other", () => {
  const markup = renderToStaticMarkup(<MemoryRouter><HomeWelcome state="unauthenticated" error={null} onSignIn={() => {}} /></MemoryRouter>);
  const note = `<p class="mb-4 mt-1 text-sm text-muted-foreground">${WELCOME_DEMO_NOTE}`;
  if (LAB) expect(markup).toMatch(new RegExp(`${note} <a [^>]*href="/feed-lab"[^>]*>Open the feed lab</a></p>`));
  else expect(markup).toContain(`${note}</p>`);
  expect(markup.includes("feed-lab")).toBe(LAB);
});
