import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsError, BotsRouteMissing, createBotsApi } from "./botsApi";
import { WEB_ACCESS_STRINGS } from "./botsStrings";
import { WebAccessToggle } from "./MainChat";
import { WebAccess, type WebAccessApi } from "./WebAccess";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const OFF = { mode: "off", hosts: [], available: true, today: { searches: 0, pages: 0, blocked: 0 } } as const;
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });

function failing(error: Error): WebAccessApi {
  return { getMainWeb: async () => { throw error; }, setMainWeb: async () => OFF };
}

async function mount(node: ReactNode) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = root;
  await act(async () => root.render(node));
  await flush();
  return host;
}

describe("a service without the web access route", () => {
  test("the client tells a 404 apart from other failures, and both still read as a failed request", async () => {
    const reply = (status: number) => createBotsApi({
      baseUrl: "https://backend.test",
      getToken: () => "session-token",
      fetch: async () => new Response("", { status }),
    });
    const missing = await reply(404).getMainWeb().catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(BotsRouteMissing);
    expect((missing as BotsError).code).toBe("failed");
    const broken = await reply(503).getMainWeb().catch((error: unknown) => error);
    expect(broken).toBeInstanceOf(BotsError);
    expect(broken).not.toBeInstanceOf(BotsRouteMissing);
  });

  test("the card renders nothing on a 404 and says so once; a server error keeps its message and Retry", async () => {
    let missingCalls = 0;
    const gone = await mount(<WebAccess api={failing(new BotsRouteMissing())} onMissing={() => { missingCalls++; }} />);
    expect(gone.querySelector("[data-bots-web-access]")).toBeNull();
    expect(gone.textContent).toBe("");
    expect(missingCalls).toBe(1);

    act(() => mounted!.unmount());
    restore?.();
    const broken = await mount(<WebAccess api={failing(new BotsError("failed"))} onMissing={() => { missingCalls++; }} />);
    expect(broken.textContent).toContain(WEB_ACCESS_STRINGS.loadFailed);
    expect([...broken.querySelectorAll("button")].length).toBeGreaterThan(0);
    expect(missingCalls).toBe(1);
  });

  test("opening Web access on a 404 removes the button, and it stays gone when Main's chat is opened again", async () => {
    const api = failing(new BotsRouteMissing());
    const host = await mount(<WebAccessToggle api={api} />);
    const button = [...host.querySelectorAll("button")].find((node) => node.textContent === WEB_ACCESS_STRINGS.title)!;
    await act(async () => { button.click(); });
    await flush();
    expect(host.querySelector("button")).toBeNull();

    act(() => mounted!.unmount());
    restore?.();
    const again = await mount(<WebAccessToggle api={api} />);
    expect(again.querySelector("button")).toBeNull();
  });
});
