import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { APPS_EMPTY, APPS_PAGE_LEAD } from "@/lib/homeStrings";
import { AppsPage } from "./AppsPage";
import { SHARE_APPS, shareRunUrl } from "./shareApps";

const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe("Apps", () => {
  test("lists Notes, Health Log and Recipes as links that open Share's runner in a new tab, rel noopener", () => {
    const markup = render(<AppsPage />);
    const anchors = [...markup.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
    expect(anchors).toHaveLength(3);
    for (const tag of anchors) {
      expect(tag).toContain('target="_blank"');
      expect(/rel="([^"]*)"/.exec(tag)?.[1].split(" ")).toContain("noopener");
    }
    expect(anchors[0]).toContain('href="https://share.tinycloud.xyz/apps/run#com.example.notes"');
    expect(anchors[1]).toContain('href="https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.healthlog"');
    expect(anchors[2]).toContain('href="https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.recipes"');
    for (const name of ["Notes", "Health Log", "Recipes"]) expect(markup).toContain(name);
  });

  test("says it opens Share and makes no embedding or permission claim in the lead", () => {
    const markup = render(<AppsPage />);
    expect(markup).toContain(APPS_PAGE_LEAD);
    expect(APPS_PAGE_LEAD).toContain("TinyCloud Share");
    expect(markup).toContain("Open in Share");
    expect(markup).toContain("(opens in a new tab)");
  });

  test("an empty list shows the empty state and no links", () => {
    const markup = render(<AppsPage apps={[]} />);
    expect(markup).toContain(APPS_EMPTY);
    expect(markup).not.toContain("<a ");
  });

  test("the run URL carries only the app id in the fragment (no user data)", () => {
    expect(SHARE_APPS.map((app) => shareRunUrl(app.appId))).toEqual([
      "https://share.tinycloud.xyz/apps/run#com.example.notes",
      "https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.healthlog",
      "https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.recipes",
    ]);
  });
});
