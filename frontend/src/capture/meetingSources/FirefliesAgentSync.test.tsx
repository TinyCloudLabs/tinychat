import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { FirefliesAgentSync } from "./ManagePanel";

test("pairing presents the agent DID input and signed-session grant scope", () => {
  const html = renderToStaticMarkup(<FirefliesAgentSync tcw={{} as never} />);
  expect(html).toContain("Pair local agent-sync");
  expect(html).toContain("Agent session DID");
  expect(html).toContain("Create grant file");
  expect(html).toContain("Fireflies named-key decrypt");
  expect(html).toContain("active TinyCloud session signs a terminal grant");
  expect(html).toContain("No wallet prompt is expected");
});
