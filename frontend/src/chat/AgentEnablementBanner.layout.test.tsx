// The agent access prompt on a phone (TC-522). Positioned at `left-1/2`, a
// fixed box only gets half the viewport to lay out in, so at 412 px the prompt
// was squeezed into a narrow column with the button beside the text. At 390
// px it spans the width as a compact row. The explanatory helper hides below
// `sm` to keep the Markdown demo visible. On a phone it is fixed to the tab bar;
// from `md` it is absolute in the pane.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentEnablementBanner } from "./AgentEnablementBanner";

const baseProps = {
  capability: "available" as const,
  enableError: null,
  enabling: false,
  onEnable: async () => {},
  reconnectReason: null,
  silentlyEnabled: false,
};

/** The class list of the first element whose opening tag contains `marker`. */
function classList(markup: string, marker: string): string[] {
  for (const [tag] of markup.matchAll(/<[a-z]+[^>]*>/g)) {
    if (tag.includes(marker)) return /class="([^"]*)"/.exec(tag)?.[1].split(" ") ?? [];
  }
  throw new Error(`no element matches ${marker}`);
}

describe("AgentEnablementBanner layout", () => {
  for (const [name, props] of [
    ["the connect prompt", baseProps],
    ["the error / retry state", { ...baseProps, enableError: "Something went wrong." }],
  ] as const) {
    test(`${name}: phone offset, compact row and pane positioning`, () => {
      const markup = renderToStaticMarkup(<AgentEnablementBanner {...props} />);

      const region = classList(markup, 'role="region"');
      expect(region).toEqual(expect.arrayContaining(["fixed", "left-3", "right-3", "md:absolute", "md:bottom-32"]));
      expect(region).not.toContain("left-1/2");
      expect(region).not.toContain("-translate-x-1/2");
      expect(region).toEqual(
        expect.arrayContaining(["sm:left-1/2", "sm:right-auto", "sm:-translate-x-1/2"]),
      );
      // 7.75rem above whatever covers the bottom: the tab bar (and the recording
      // island) on a phone, else the home indicator / gesture bar (index.css),
      // which clears the composer and its toolbar row. Under the composer's
      // menus (its z-10 layer) and sheets.
      expect(region).toContain("bottom-[calc(var(--tc-bottom-chrome)+7.75rem)]");
      expect(region).toContain("z-[5]");

      const card = classList(markup, "rounded-lg");
      expect(card).toEqual(expect.arrayContaining(["flex", "items-center", "gap-2", "py-1.5"]));
      expect(card).not.toContain("flex-col");

      if (props.enableError === null) {
        const helper = classList(markup, "data-agent-enable-helper");
        expect(helper).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
      }

      // 44px wherever the pointer is a finger (a tablet too); compact with a mouse.
      const button = classList(markup, "<button");
      expect(button).toEqual(expect.arrayContaining(["min-h-11", "fine:min-h-0"]));
      expect(button).not.toContain("sm:min-h-0");
    });
  }

  test("the 'Agent tools active.' toast keeps its centred pill, clear of the home indicator", () => {
    const markup = renderToStaticMarkup(
      <AgentEnablementBanner {...baseProps} capability="enabled" silentlyEnabled />,
    );
    const toast = classList(markup, 'role="status"');
    expect(toast).toEqual(expect.arrayContaining(["fixed", "left-1/2", "-translate-x-1/2", "md:absolute", "md:bottom-32"]));
    expect(toast).toContain("bottom-[calc(var(--tc-bottom-chrome)+8rem)]");
    expect(markup).toContain("Agent tools active.");
  });
});
