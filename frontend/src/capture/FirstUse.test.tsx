import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { FirstUse } from "./FirstUse";

const render = (platform: "ios" | "web") => renderToStaticMarkup(<MemoryRouter><FirstUse platform={platform} /></MemoryRouter>);

describe("FirstUse", () => {
  test("the display headline and one short line", () => {
    const html = render("ios");
    expect(html).toContain('data-testid="capture-first-use"');
    expect(html).toContain("Think out loud.");
    expect(html).toContain("font-display text-display");
  });

  test("where nothing records, it invites a conversation instead", () => {
    expect(render("web")).toContain("Bring in a conversation.");
  });
});
