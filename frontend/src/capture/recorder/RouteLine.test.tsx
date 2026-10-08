// "Where your audio goes": an ordered list with one item per stop on the route.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RouteLine, voiceNoteRoute } from "./RouteLine";

const items = (html: string) => [...html.matchAll(/<li[^>]*data-node="([^"]+)"[^>]*>.*?<span class="pr-2[^"]*">([^<]+)/g)].map((m) => [m[1], m[2]]);

describe("RouteLine", () => {
  test("an ordered list named for what it shows", () => {
    const html = renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("off")} />);
    expect(html).toStartWith('<ol aria-label="Where your audio goes"');
  });

  test("off: this phone straight to your space", () => {
    expect(items(renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("off")} />))).toEqual([
      ["source", "This phone"],
      ["destination", "Your space"],
    ]);
  });

  test("private cloud: through private cloud, which is a processing stop", () => {
    expect(items(renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("private-cloud")} />))).toEqual([
      ["source", "This phone"],
      ["processing", "Private cloud"],
      ["destination", "Your space"],
    ]);
  });

  test("on-device: transcribed on this phone before it ever leaves", () => {
    expect(items(renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("on-device")} />))).toEqual([
      ["source", "This phone (transcribed here)"],
      ["destination", "Your space"],
    ]);
  });

  test("landed: the space is checked, and says so to a screen reader", () => {
    const html = renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("private-cloud")} landed />);
    expect(html).toContain("data-landed");
    expect(html).toContain("lucide-check");
    expect(html).toContain('<span class="sr-only"> (saved)</span>');
    expect(renderToStaticMarkup(<RouteLine nodes={voiceNoteRoute("private-cloud")} />)).not.toContain("lucide-check");
  });
});
