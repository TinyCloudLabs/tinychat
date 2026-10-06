// List rows (TC-761; the title rule moved from MeetingsPage.test.tsx, TC-522):
// a long title stays readable on a phone, wrapping onto more lines instead of
// being cut beside the row's duration; a caller can still ask for a clamp.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

import { ListRow } from "./list-row";

const TITLE = "Voice note · Sep 29, 1:40 PM, the planning call with the venue";

function classesOf(markup: string, text: string): string[] {
  const at = markup.indexOf(`>${text}`);
  expect(at).toBeGreaterThan(-1);
  const open = markup.lastIndexOf("<", at);
  return /class="([^"]*)"/.exec(markup.slice(open, at))?.[1].split(" ") ?? [];
}

const render = (patch: Partial<Parameters<typeof ListRow>[0]> = {}) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ul>
        <ListRow href="/chat/capture/library/row-1" title={TITLE} meta="Today 1:40 PM" aside={<span>0:42</span>} {...patch} />
      </ul>
    </MemoryRouter>,
  );

describe("ListRow", () => {
  test("a long title wraps (never truncated beside the duration)", () => {
    const title = classesOf(render(), TITLE);
    expect(title).not.toContain("truncate");
    expect(title.some((c) => c.startsWith("line-clamp"))).toBe(false);
    expect(title).toContain("[overflow-wrap:anywhere]");
  });

  test("a caller can clamp it", () => {
    expect(classesOf(render({ titleLines: 2 }), TITLE)).toContain("line-clamp-2");
  });

  test("the row is one link; trailing controls sit beside it, never inside", () => {
    const html = render({ trailing: <button type="button">End</button> });
    const link = html.slice(html.indexOf("<a "), html.indexOf("</a>"));
    expect(link).toContain(TITLE);
    expect(link).not.toContain("<button");
    expect(html.indexOf(">End</button>")).toBeGreaterThan(html.indexOf("</a>"));
  });

  test("the open note's row is current and heavier", () => {
    const html = render({ selected: true });
    expect(html).toContain('aria-current="page"');
    expect(classesOf(html, TITLE)).toContain("font-semibold");
  });
});
