import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ViaMenu } from "./ViaMenu";

const INPUTS = [
  { id: "builtin", name: "iPhone Microphone", kind: "built_in" as const },
  { id: "pods", name: "Sam's AirPods Pro", kind: "bluetooth" as const },
];

function open(currentId: string | null) {
  return renderToStaticMarkup(
    <ViaMenu
      inputs={INPUTS}
      currentId={currentId}
      currentName="iPhone Microphone"
      recording={false}
      theme="night"
      subscribeLevel={() => () => {}}
      emphasis={false}
      disabled={false}
      onSelect={() => {}}
      defaultOpen
    />,
  );
}

const checked = (html: string) => [...html.matchAll(/aria-checked="true"/g)].length;
const checkIcons = (html: string) => [...html.matchAll(/class="ok"/g)].length;

describe("the via menu", () => {
  test("checks exactly the current input and shows friendly names", () => {
    const html = open("builtin");
    expect(html).toContain("iPhone Microphone");
    expect(html).not.toContain("MicrophoneBuiltIn");
    expect(checked(html)).toBe(1);
    expect(checkIcons(html)).toBe(1);
    expect(html.indexOf('aria-checked="true"')).toBeLessThan(html.indexOf("Sam&#x27;s AirPods Pro"));
  });

  test("follows the current input to another row", () => {
    const html = open("pods");
    expect(checked(html)).toBe(1);
    expect(html.indexOf('aria-checked="true"')).toBeGreaterThan(html.indexOf("iPhone Microphone"));
  });

  test("checks nothing when the current id is not a listed input", () => {
    expect(checked(open("exo-sim-silence"))).toBe(0);
  });
});
