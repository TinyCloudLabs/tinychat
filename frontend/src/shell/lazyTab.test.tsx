import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { installDom } from "@/test/dom";
import { lazyTab } from "./lazyTab";

function Greeting({ name }: { name: string }) {
  return <h1>Hello {name}</h1>;
}

describe("lazyTab", () => {
  test("renders nothing while its chunk loads", () => {
    const Tab = lazyTab("Greeting", () => new Promise<typeof Greeting>(() => {}));
    expect(renderToStaticMarkup(<Tab name="Ada" />)).toBe("");
  });

  test("once preloaded, renders at once with its props, and loads its chunk only once", async () => {
    const load = mock(() => Promise.resolve(Greeting));
    const Tab = lazyTab("Greeting", load);
    await Promise.all([Tab.preload(), Tab.preload()]);
    expect(renderToStaticMarkup(<Tab name="Ada" />)).toBe("<h1>Hello Ada</h1>");
    expect(load).toHaveBeenCalledTimes(1);
  });

  test("a failed load is not kept: the next attempt fetches the chunk again", async () => {
    const load = mock(() => Promise.reject<typeof Greeting>(new Error("offline")));
    const Tab = lazyTab("Greeting", load);
    await expect(Tab.preload()).rejects.toThrow("offline");
    load.mockImplementation(() => Promise.resolve(Greeting));
    await Tab.preload();
    expect(load).toHaveBeenCalledTimes(2);
    expect(renderToStaticMarkup(<Tab name="Ada" />)).toContain("Ada");
  });
});

describe("lazyTab load failures", () => {
  let restoreDom: (() => void) | undefined;
  let root: Root | null = null;
  let host: HTMLElement;
  let quiet: { mockRestore: () => void } | undefined;
  beforeEach(() => {
    restoreDom = installDom();
    host = document.createElement("div");
    document.body.appendChild(host);
    // React and the boundary report each caught load failure.
    quiet = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    quiet?.mockRestore();
    restoreDom?.();
  });

  const chunkError = () => new TypeError("Failed to fetch dynamically imported module: https://localhost/assets/Greeting-x1.js");

  async function show(node: ReactNode, platform: AppPlatform = "ios", phase: "idle" | "recording" = "idle") {
    root ??= createRoot(host);
    await act(async () =>
      root!.render(
        <PlatformContext.Provider value={platform}>
          <StaticRecorderProvider value={{ phase }}>{node}</StaticRecorderProvider>
        </PlatformContext.Provider>,
      ));
  }

  async function click(label: string) {
    const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  }

  test("a chunk the browser could not fetch offers a reload: asking again for the same URL won't help", async () => {
    const reload = mock(() => {});
    const Tab = lazyTab("Greeting", () => Promise.reject<typeof Greeting>(chunkError()), reload);
    await show(<Tab name="Ada" />);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open Greeting.");
    await click("Reload TinyCloud Home");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("any other failure offers Try again, which loads afresh; a retry that fails too offers the reload", async () => {
    const load = mock(() => Promise.reject<typeof Greeting>(new Error("boom")));
    const Tab = lazyTab("Greeting", load, () => {});
    await show(<Tab name="Ada" />);
    await click("Try again");
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Reload TinyCloud Home");
  });

  test("Try again shows the screen once its chunk loads", async () => {
    const load = mock(() => Promise.reject<typeof Greeting>(new Error("boom")));
    const Tab = lazyTab("Greeting", load, () => {});
    await show(<Tab name="Ada" />);
    load.mockImplementation(() => Promise.resolve(Greeting));
    await click("Try again");
    expect(host.innerHTML).toBe("<h1>Hello Ada</h1>");
  });

  test("opening the screen again after a failure loads it again", async () => {
    const load = mock(() => Promise.reject<typeof Greeting>(new Error("boom")));
    const Tab = lazyTab("Greeting", load, () => {});
    await show(<Tab name="Ada" />);
    await show(null);
    load.mockImplementation(() => Promise.resolve(Greeting));
    await show(<Tab name="Ada" />);
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.innerHTML).toBe("<h1>Hello Ada</h1>");
  });

  test("on the web, a reload during a recording asks first: it would stop the recording", async () => {
    const reload = mock(() => {});
    const Tab = lazyTab("Greeting", () => Promise.reject<typeof Greeting>(chunkError()), reload);
    await show(<Tab name="Ada" />, "web", "recording");
    await click("Reload TinyCloud Home");
    expect(reload).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Reloading stops this recording in the browser.");
    await click("Reload");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
