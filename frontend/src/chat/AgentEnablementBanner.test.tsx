import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentAccessDetails,
  AgentEnablementBanner,
} from "./AgentEnablementBanner";

const noop = async () => {};

describe("AgentEnablementBanner", () => {
  test("names the private agent action and explains the user-visible outcome", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner
        capability="available"
        enableError={null}
        enabling={false}
        onEnable={noop}
      />,
    );

    expect(markup).toContain("Enable private agent");
    expect(markup).toContain(
      "Let your agent remember useful context and answer questions from your synced meeting transcripts.",
    );
    expect(markup).toContain('aria-label="What private agent access includes"');
    expect(markup).not.toContain("Enable agent memory &amp; tools");
  });

  test("the access explanation distinguishes memory from read-only transcript access", () => {
    const markup = renderToStaticMarkup(<AgentAccessDetails />);

    expect(markup).toContain("Agent memory");
    expect(markup).toContain("Meeting transcript access");
    expect(markup).toContain("Transcript access is read-only");
    expect(markup).toContain("expires after 7 days");
  });

  test("the transient success state confirms that the private agent is enabled", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner
        capability="enabled"
        enableError={null}
        enabling={false}
        onEnable={noop}
        silentlyEnabled
      />,
    );

    expect(markup).toContain("Private agent enabled.");
  });
});
