// Connectors scrolled the whole app shell (header and sidebar left the viewport,
// a blank band opened below the content, Transcriber tab switches jumped the
// page). The cause: the `sr-only` form labels are absolutely positioned, and the
// scroller was not a containing block, so they resolved against the initial
// containing block and stretched the document. The scroller must stay
// `relative`. test/connectors-scroll.e2e.test.ts checks the rendered geometry.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectorsPage } from "./ConnectorsPage";

const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
const sessionStore = {} as unknown as SessionStore;

describe("ConnectorsPage layout", () => {
  for (const tab of ["sources", "library"] as const) {
    test(`${tab}: the scroller is the containing block for absolutely positioned content`, () => {
      const markup = renderToStaticMarkup(
        <MemoryRouter>
          <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={sessionStore} tab={tab} />
        </MemoryRouter>,
      );
      const root = /^<div class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
      expect(root).toEqual(expect.arrayContaining(["relative", "h-full", "overflow-y-auto"]));
    });
  }
});
