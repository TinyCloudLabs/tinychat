import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SegmentedControl } from "./segmented-control";

const OPTIONS = [
  { value: "off", label: "Off" },
  { value: "private", label: "Private cloud" },
  { value: "assemblyai", label: "AssemblyAI", disabled: true },
] as const;

function render(value: string) {
  return renderToStaticMarkup(
    <SegmentedControl aria-label="Transcription" value={value} onValueChange={() => {}} options={OPTIONS} />,
  );
}

/** The opening tag of each segment, in order. */
const segments = (markup: string) => [...markup.matchAll(/<button[^>]*>/g)].map((m) => m[0]);

describe("SegmentedControl", () => {
  test("is a labelled radio group with one radio per option", () => {
    const markup = render("private");
    expect(markup).toMatch(/<div[^>]*role="radiogroup"[^>]*>/);
    expect(markup).toContain('aria-label="Transcription"');
    const radios = segments(markup);
    expect(radios).toHaveLength(3);
    for (const radio of radios) expect(radio).toContain('role="radio"');
  });

  test("the selected segment is checked; the others are not", () => {
    const [off, privateCloud, assemblyai] = segments(render("private"));
    expect(privateCloud).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
    expect(assemblyai).toContain('aria-checked="false"');
  });

  test("selection is not colour alone: a check before the selected label, and the thumb's edge", () => {
    const markup = render("private");
    expect(markup.match(/lucide-check/g)).toHaveLength(1);
    expect(markup.indexOf("lucide-check")).toBeLessThan(markup.indexOf("Private cloud"));
    expect(markup).toContain("data-segmented-thumb");
    expect(markup).toContain("border-primary");
  });

  test("a disabled option is disabled", () => {
    const [off, , assemblyai] = segments(render("off"));
    expect(assemblyai).toMatch(/\sdisabled=""/);
    expect(off).not.toMatch(/\sdisabled=""/);
  });

  test("with no option selected there is no thumb and nothing is checked", () => {
    const markup = render("none");
    expect(markup).not.toContain("data-segmented-thumb");
    expect(markup).not.toContain('aria-checked="true"');
  });
});
