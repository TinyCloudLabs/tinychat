import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { MODE_STOPS } from "./transcriptionModes";
import { ModeIcon } from "./softIcons";

test("every transcription mode renders a non-empty glyph at the slider size", () => {
  for (const { id } of MODE_STOPS) {
    const html = renderToStaticMarkup(<ModeIcon id={id} size={14} />);
    expect(html).toMatch(/<svg\b[^>]*width="14"[^>]*aria-hidden="true"[^>]*>\s*<(?:path|circle|rect)\b/);
  }
});
