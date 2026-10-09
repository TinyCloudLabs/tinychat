import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LevelBars,
  mirroredBandIndex,
  MirroredSpectrumBars,
  ribbonBarScale,
  viaBarHeights,
} from "./LevelBars";
import { sourceFromLevel } from "./source";

describe("level bars", () => {
  test("renders the requested number of level bars", () => {
    const html = renderToStaticMarkup(
      <LevelBars bars={5} levels={[0.2, 0.4, 0.6, 0.8, 1]} />,
    );
    expect((html.match(/data-bar=/g) ?? []).length).toBe(5);
    expect(html).toContain('data-level-bars=""');
    expect(html).toContain("width:2.5px");
    expect(html).toContain("height:12px");
    expect(viaBarHeights(0)).toEqual([0.25, 0.25, 0.25]);
    expect(viaBarHeights(0.5)[0]).toBeCloseTo(0.775);
  });

  test("mirrors bass into the center of 30 and 22 bar spectrums", () => {
    expect(mirroredBandIndex(14, 30)).toBe(0);
    expect(mirroredBandIndex(15, 30)).toBe(0);
    expect(mirroredBandIndex(10, 22)).toBe(1);
    expect(mirroredBandIndex(11, 22)).toBe(1);
    expect(mirroredBandIndex(0, 22)).toBe(27);

    const html = renderToStaticMarkup(
      <MirroredSpectrumBars bars={22} source={sourceFromLevel(0.8)} />,
    );
    expect((html.match(/data-bar=/g) ?? []).length).toBe(22);
    expect(html).toContain('data-spectrum-bars=""');
    expect(html).toContain("width:2.5px");
    expect(html).toContain("height:18px");
    expect(html).toContain("justify-content:space-between");

    const ribbon = renderToStaticMarkup(
      <MirroredSpectrumBars bars={30} source={sourceFromLevel(0.8)} />,
    );
    expect(ribbon).toContain("width:3px");
    expect(ribbon).toContain("height:30px");
    expect(ribbonBarScale(0, 0)).toBeCloseTo(0.12);
  });

  test("renders paused meters in neutral grey", () => {
    const level = renderToStaticMarkup(
      <LevelBars paused levels={[0.5, 0.5, 0.5]} />,
    );
    const spectrum = renderToStaticMarkup(
      <MirroredSpectrumBars paused bars={30} source={sourceFromLevel(0.5)} />,
    );
    expect(level).toContain("background:#8f8993");
    expect(spectrum).toContain("background:#8f8993");
    expect(level).toContain('data-paused="true"');
    expect(spectrum).toContain('data-paused="true"');
    expect(spectrum).not.toContain("scaleY(0.120)");
    expect(level).toContain("scaleY(0.500)");
  });
});
