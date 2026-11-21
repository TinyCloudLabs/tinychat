// Connectors under the shell (TC-761): one page, one heading, no way back
// (it is a destination). Moved from connectorsNav.test.tsx when that file went
// (PR6); the Library's half ("both meeting data paths") is in
// capture/library/LibraryListView.test.tsx.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { ConnectorsPage } from "./ConnectorsPage";

describe("Connectors page composition under the new IA", () => {
  const tcw = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as unknown as TinyCloudWeb;
  const markup = renderToStaticMarkup(
    <MemoryRouter>
      <ConnectorsPage tcw={tcw} backendUrl="http://127.0.0.1" sessionStore={{} as SessionStore} />
    </MemoryRouter>,
  );

  test("one page heading, and no back affordance", () => {
    expect(markup.match(/<h1/g)).toHaveLength(1);
    const heading = markup.slice(markup.indexOf("<h1"), markup.indexOf("</h1>"));
    expect(heading).toContain(">Connectors<");
    // A destination: the shell's navigation is the way elsewhere.
    expect(markup).not.toContain("Back to chat");
    expect(markup).not.toContain(">Back<");
  });
});
