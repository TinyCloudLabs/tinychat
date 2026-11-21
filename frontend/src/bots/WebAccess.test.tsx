import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsError, type MainWebSettings } from "./botsApi";
import { WEB_ACCESS_STRINGS } from "./botsStrings";
import { WebAccess, parseHosts, type WebAccessApi } from "./WebAccess";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const OFF: MainWebSettings = { mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } };

function fake(initial: MainWebSettings | Error, save?: (body: { mode: string; hosts: string[] }) => Promise<MainWebSettings>) {
  const saves: { mode: string; hosts: string[] }[] = [];
  let loads = 0;
  const api: WebAccessApi = {
    getMainWeb: async () => {
      loads++;
      if (initial instanceof Error && (loads === 1 || !save)) throw initial;
      return initial instanceof Error ? OFF : initial;
    },
    setMainWeb: async (body) => {
      saves.push({ mode: body.mode, hosts: [...body.hosts] });
      if (!save) throw new Error("no save");
      return save(body);
    },
  };
  return { api, saves };
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

async function render(api: WebAccessApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(<WebAccess api={api} />));
  await flush();
  return host;
}

const radio = (host: HTMLElement, mode: string) => host.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!;
const checked = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find((input) => input.checked)?.value;
const button = (host: HTMLElement, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label) as HTMLButtonElement | undefined;
const list = (host: HTMLElement) => host.querySelector("textarea")!;

async function pick(host: HTMLElement, mode: string) {
  await act(async () => { radio(host, mode).click(); });
}
// React decides at import time whether the DOM has a native input event; without one it watches focus and key events,
// so the helper focuses the field and sends both kinds of event.
async function type(host: HTMLElement, value: string) {
  const area = list(host);
  area.focus();
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(area, value);
  await act(async () => {
    area.dispatchEvent(new Event("input", { bubbles: true }));
    area.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "a" }));
  });
}
async function click(node: HTMLElement | undefined) {
  expect(node).toBeDefined();
  await act(async () => { node!.click(); });
  await flush();
}

describe("WebAccess", () => {
  test("shows Off selected by default, three labelled presets and the off line", async () => {
    const { api } = fake(OFF);
    const host = await render(api);
    expect(checked(host)).toBe("off");
    const labels = [...host.querySelectorAll("label")].map((node) => node.textContent);
    for (const preset of Object.values(WEB_ACCESS_STRINGS.presets)) {
      expect(labels.some((text) => text?.includes(preset.label) && text.includes(preset.description))).toBe(true);
    }
    expect(host.textContent).toContain(WEB_ACCESS_STRINGS.offDescription);
    expect(host.querySelector("textarea")).toBeNull();
    expect(button(host, "Save")?.disabled).toBe(true);
  });

  test("a failed load shows a failure line and retry loads again", async () => {
    const { api } = fake(new Error("offline"), async () => OFF);
    const host = await render(api);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(WEB_ACCESS_STRINGS.loadFailed);
    await click(button(host, "Try again"));
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(checked(host)).toBe("off");
  });

  test.each(["listed", "any"] as const)("turning on %s shows the warning before saving, and Turn on saves", async (mode) => {
    const { api, saves } = fake(OFF, async (body) => ({ ...OFF, ...body, today: { searches: 4, pages: 9, blocked: 0 } }));
    const host = await render(api);
    await pick(host, mode);
    if (mode === "listed") await type(host, "Docs.Example.com\nexample.org\ndocs.example.com");
    await click(button(host, "Save"));
    expect(saves).toHaveLength(0);
    expect(host.querySelector('[role="alertdialog"]')?.textContent).toContain(WEB_ACCESS_STRINGS.warningTitle);
    expect(host.textContent).toContain(WEB_ACCESS_STRINGS.warningBody);
    expect(host.textContent?.includes(WEB_ACCESS_STRINGS.warningBodyAny)).toBe(mode === "any");
    await click(button(host, "Turn on"));
    expect(saves).toEqual([{ mode, hosts: mode === "listed" ? ["docs.example.com", "example.org"] : [] }]);
    expect(checked(host)).toBe(mode);
    expect(host.textContent).toContain("Searched 4 times and read 9 pages today.");
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("Not now changes nothing and never calls the API", async () => {
    const { api, saves } = fake(OFF, async (body) => ({ ...OFF, ...body }));
    const host = await render(api);
    await pick(host, "any");
    await click(button(host, "Save"));
    await click(button(host, "Not now"));
    expect(saves).toHaveLength(0);
    expect(checked(host)).toBe("off");
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  });

  test("widening from a list to any public site warns; narrowing and editing the list do not", async () => {
    const listed: MainWebSettings = { ...OFF, mode: "listed", hosts: ["docs.example.com"] };
    const { api, saves } = fake(listed, async (body) => ({ ...listed, ...body }));
    const host = await render(api);
    expect(checked(host)).toBe("listed");
    expect(list(host).value).toBe("docs.example.com");

    await type(host, "docs.example.com\nexample.org");
    await click(button(host, "Save"));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(saves).toEqual([{ mode: "listed", hosts: ["docs.example.com", "example.org"] }]);

    await pick(host, "any");
    await click(button(host, "Save"));
    expect(saves).toHaveLength(1);
    expect(host.querySelector('[role="alertdialog"]')).not.toBeNull();
    await click(button(host, "Turn on"));
    expect(saves).toHaveLength(2);
    expect(saves[1]!.mode).toBe("any");

    await pick(host, "listed");
    await type(host, "example.net");
    await click(button(host, "Save"));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(saves).toHaveLength(3);
  });

  test("an invalid list shows the error and blocks the call", async () => {
    const { api, saves } = fake(OFF, async (body) => ({ ...OFF, ...body }));
    const host = await render(api);
    await pick(host, "listed");
    for (const bad of ["", "https://example.com", "example.com/docs", "example.com:8080", "localhost", "127.0.0.1", "exa mple.com", "bücher.de", "-a.example.com", "a..example.com", Array.from({ length: 51 }, (_, index) => `h${index}.example.com`).join("\n")]) {
      await type(host, bad);
      await click(button(host, "Save"));
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(WEB_ACCESS_STRINGS.listError);
      expect(host.querySelector('[role="alertdialog"]')).toBeNull();
      expect(saves).toHaveLength(0);
    }
  });

  test("Off needs no warning and saves at once", async () => {
    const on: MainWebSettings = { ...OFF, mode: "any", today: { searches: 1, pages: 1, blocked: 0 } };
    const { api, saves } = fake(on, async (body) => ({ ...on, ...body }));
    const host = await render(api);
    expect(host.textContent).toContain("Searched 1 time and read 1 page today.");
    await pick(host, "off");
    await click(button(host, "Save"));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(saves).toEqual([{ mode: "off", hosts: [] }]);
    expect(checked(host)).toBe("off");
    expect(host.textContent).toContain(WEB_ACCESS_STRINGS.offDescription);
    expect(host.textContent).not.toContain("Searched");
  });

  test("a failed save keeps the previous selection and offers a retry", async () => {
    let fail = true;
    const { api, saves } = fake(OFF, async (body) => {
      if (fail) throw new BotsError("failed");
      return { ...OFF, ...body };
    });
    const host = await render(api);
    await pick(host, "any");
    await click(button(host, "Save"));
    await click(button(host, "Turn on"));
    expect(saves).toHaveLength(1);
    expect(checked(host)).toBe("off");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(WEB_ACCESS_STRINGS.saveFailed);
    fail = false;
    await click(button(host, "Try again"));
    expect(saves).toHaveLength(2);
    expect(checked(host)).toBe("any");
    expect(host.textContent).not.toContain(WEB_ACCESS_STRINGS.saveFailed);
  });

  test("a refused list shows the list hint instead of the generic failure", async () => {
    const { api } = fake(OFF, async () => { throw new BotsError("invalid"); });
    const host = await render(api);
    await pick(host, "listed");
    await type(host, "example.com");
    await click(button(host, "Save"));
    await click(button(host, "Turn on"));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(WEB_ACCESS_STRINGS.listError);
    expect(checked(host)).toBe("off");
  });

  test("when web access is unavailable the on-presets are disabled and the line says so", async () => {
    const { api } = fake({ ...OFF, available: false });
    const host = await render(api);
    expect(host.textContent).toContain(WEB_ACCESS_STRINGS.unavailable);
    expect(radio(host, "listed").disabled).toBe(true);
    expect(radio(host, "any").disabled).toBe(true);
    expect(radio(host, "off").disabled).toBe(false);
  });

  test("server text is shown as plain text, never as HTML", async () => {
    const { api } = fake({ ...OFF, mode: "listed", hosts: ["<img src=x onerror=alert(1)>"], today: { searches: 0, pages: 0, blocked: 0 } });
    const host = await render(api);
    expect(host.querySelector("img")).toBeNull();
    expect(list(host).value).toBe("<img src=x onerror=alert(1)>");
  });
});

describe("usageLine", () => {
  test("pluralises and hides when nothing happened yet", () => {
    const line = WEB_ACCESS_STRINGS.usageLine;
    expect(line({ searches: 4, pages: 9 })).toBe("Searched 4 times and read 9 pages today.");
    expect(line({ searches: 1, pages: 1 })).toBe("Searched 1 time and read 1 page today.");
    expect(line({ searches: 0, pages: 2 })).toBe("Searched 0 times and read 2 pages today.");
    expect(line({ searches: 0, pages: 0 })).toBe("");
  });
});

describe("parseHosts", () => {
  test("lowercases, de-duplicates and ignores blank lines", () => {
    expect(parseHosts(" Docs.Example.com \n\nexample.org\r\ndocs.example.com")).toEqual(["docs.example.com", "example.org"]);
  });
  test("rejects an empty list, more than 50 sites and non-hostnames", () => {
    expect(parseHosts("")).toBeNull();
    expect(parseHosts("a.example.com\nhttp://b.example.com")).toBeNull();
    expect(parseHosts("1.2.3.4")).toBeNull();
    expect(parseHosts(Array.from({ length: 50 }, (_, index) => `h${index}.example.com`).join("\n"))).toHaveLength(50);
  });
});
