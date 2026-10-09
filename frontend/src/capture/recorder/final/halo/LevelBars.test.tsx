import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LevelBars, MirroredSpectrumBars } from "./LevelBars";
import { sourceFromLevel } from "./source";

describe("level bars", () => {
  test("renders the requested meter bar count and recording state", () => {
    const html = renderToStaticMarkup(<LevelBars bars={5} levels={[0.2, 0.4, 0.6, 0.8, 1]} />);
    expect((html.match(/data-bar=/g) ?? []).length).toBe(5);
    expect(html).toContain('data-level-bars=""');
    expect(html).toContain("scaleY(0.08)");
  });

  test("renders mirrored bars with bass at the centre", () => {
    const html = renderToStaticMarkup(<MirroredSpectrumBars bars={22} source={sourceFromLevel(0.8)} paused />);
    expect((html.match(/data-bar=/g) ?? []).length).toBe(22);
    expect(html).toContain('data-spectrum-bars=""');
    expect(html).toContain('data-paused="true"');
  });
});
