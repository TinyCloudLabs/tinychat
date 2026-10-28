import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadListLoadNotice } from "./ThreadList";

test("cached-list retry link has a 24px minimum hit area", () => {
  const markup = renderToStaticMarkup(
    <ThreadListLoadNotice state={{ status: "error", hasCache: true }} onRetry={() => {}} />,
  );
  const button = markup.match(/<button\b[^>]*>Try again<\/button>/)?.[0];
  expect(button).toBeDefined();
  expect(button).toMatch(/\binline-flex\b/);
  expect(button).toMatch(/\bmin-h-6\b/);
});
