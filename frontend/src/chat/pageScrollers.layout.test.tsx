// Connectors (and Settings) scrolled the whole app shell: header and sidebar
// left the viewport, a blank band opened below the content, Transcriber tab
// switches jumped the page. The cause: `sr-only` labels are absolutely
// positioned, and the page scroller was not a containing block, so they resolved
// against the initial containing block and stretched the document. Each page
// scroller must stay `relative`. test/connectors-scroll.e2e.test.ts checks the
// rendered geometry.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectorsPage } from "./ConnectorsPage";

const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
const sessionStore = {} as unknown as SessionStore;

/** The class list of the page's root element. */
function rootClasses(markup: string): string[] {
  return /^<div class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
}

describe("page scroller layout", () => {
  for (const tab of ["sources", "library"] as const) {
    test(`Connectors ${tab}: the scroller is the containing block for absolutely positioned content`, () => {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={sessionStore} tab={tab} />
        </MemoryRouter>,
      );
      expect(rootClasses(markup)).toEqual(expect.arrayContaining(["relative", "h-full", "overflow-y-auto"]));
    });
  }

  // SettingsPage imports App (DOM-only SDKs at module load), so it cannot be
  // server-rendered here; assert its root scroller in source, like
  // ConnectorsCard.test.ts does for the IA. The e2e test renders it for real.
  test("Settings: the scroller is the containing block for absolutely positioned content", () => {
    const source = readFileSync(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
    expect(source).toContain('<div className="relative h-full overflow-y-auto">');
    expect(source).not.toContain('<div className="h-full overflow-y-auto">');
  });
});
