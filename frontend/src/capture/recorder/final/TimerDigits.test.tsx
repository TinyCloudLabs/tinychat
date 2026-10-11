import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDuration } from "../recorderCopy";
import { TimerDigits } from "./TimerDigits";

const slots = (text: string) =>
  [
    ...renderToStaticMarkup(<TimerDigits text={text} />).matchAll(
      /<span class="(pr-digit|pr-colon)">([^<]*)<\/span>/g,
    ),
  ].map((match) => [match[1], match[2]]);

describe("TimerDigits", () => {
  test("isolates the slots as LTR and hides them from assistive tech", () => {
    const html = renderToStaticMarkup(<TimerDigits text="12:48" />);
    expect(html).toMatch(
      /^<span class="pr-digits" dir="ltr" aria-hidden="true">/,
    );
  });

  test("puts every digit and the colon in its own slot", () => {
    expect(slots("9:59")).toEqual([
      ["pr-digit", "9"],
      ["pr-colon", ":"],
      ["pr-digit", "5"],
      ["pr-digit", "9"],
    ]);
  });

  test("slot layout depends only on the clock's shape, never on the digits", () => {
    const shape = (text: string) => slots(text).map(([kind]) => kind).join();
    const minutes = new Set<string>();
    for (let seconds = 0; seconds < 600; seconds++) {
      minutes.add(shape(formatDuration(seconds * 1000)));
    }
    expect([...minutes]).toEqual(["pr-digit,pr-colon,pr-digit,pr-digit"]);
    expect(shape(formatDuration(3600 * 1000))).toBe(
      "pr-digit,pr-colon,pr-digit,pr-digit,pr-colon,pr-digit,pr-digit",
    );
    expect(slots(formatDuration(3600 * 1000)).map(([, text]) => text).join("")).toBe(
      "1:00:00",
    );
  });
});
