import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HaloRing } from "./HaloRing";
import { BLEED } from "./renderer";

describe("HaloRing sizing", () => {
  test("keeps the layout box at the disc diameter and centers a bleeding canvas", () => {
    const markup = renderToStaticMarkup(
      <HaloRing size={172} ticks={44} theme="day" />,
    );
    const boxStyle = markup.match(/<span[^>]*style="([^"]+)"/)?.[1];
    const canvasStyle = markup.match(/<canvas[^>]*style="([^"]+)"/)?.[1];
    const layoutSize = Number(boxStyle?.match(/width:(\d+)px/)?.[1]);
    const canvasSize = Number(
      canvasStyle?.match(/width:(\d+(?:\.\d+)?)px/)?.[1],
    );

    expect(layoutSize).toBe(172);
    expect(canvasSize / BLEED).toBe(172);
    expect(canvasStyle).toContain("left:50%");
    expect(canvasStyle).toContain("top:50%");
    expect(canvasStyle).toContain("transform:translate(-50%, -50%)");
    expect(boxStyle).toContain("overflow:visible");
  });
});
