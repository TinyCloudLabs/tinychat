import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
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
