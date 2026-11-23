import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { HandoffContent } from "./HandoffPage";

test("the handoff names known apps and keeps unknown IDs out of the markup", () => {
  const unknownId = "test.private-app";
  const now = Date.now();
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <HandoffContent
        now={now}
        view={{
          agentName: "TinyCloud agent",
          machineLabel: "Computer ABC123",
          connectedAt: now,
          accessExpiresAt: now + 60_000,
          linkExpiresAt: now + 60_000,
          abilities: ["apps_data", "account_index"],
          appIds: [unknownId, "xyz.tinycloud.share"],
          appsTruncated: false,
        }}
      />
    </MemoryRouter>,
  );

  expect(html).toContain(">Another app</li>");
  expect(html).toContain(">Share</li>");
  expect(html).not.toContain(unknownId);
});
