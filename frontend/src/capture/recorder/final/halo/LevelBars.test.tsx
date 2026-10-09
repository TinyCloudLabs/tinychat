import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  LevelBars,
  mirroredBandIndex,
  MirroredSpectrumBars,
} from "./LevelBars";
import { sourceFromLevel } from "./source";

describe("level bars", () => {
  test("renders the requested number of level bars", () => {
    const html = renderToStaticMarkup(
      <LevelBars bars={5} levels={[0.2, 0.4, 0.6, 0.8, 1]} />,
    );
    expect((html.match(/data-bar=/g) ?? []).length).toBe(5);
    expect(html).toContain('data-level-bars=""');
  });

  test("mirrors bass into the center of 30 and 22 bar spectrums", () => {
    expect(mirroredBandIndex(14, 30)).toBe(0);
    expect(mirroredBandIndex(15, 30)).toBe(0);
    expect(mirroredBandIndex(10, 22)).toBe(0);
    expect(mirroredBandIndex(11, 22)).toBe(0);
    expect(mirroredBandIndex(0, 22)).toBe(31);

    const html = renderToStaticMarkup(
      <MirroredSpectrumBars bars={22} source={sourceFromLevel(0.8)} />,
    );
    expect((html.match(/data-bar=/g) ?? []).length).toBe(22);
    expect(html).toContain('data-spectrum-bars=""');
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
  });
});
