// Dialogs and typing need react-dom loaded with a DOM already installed, which a shared test process cannot promise:
// run by src/NodeAddressSettings.test.ts in its own process.
import { restoreDomBeforeReact, setValue } from "@/test/domBeforeReact";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installDom } from "@/test/dom";
import { PlatformContext, type AppPlatform } from "@/lib/platform";
import { NODE_HOST_STORAGE_KEY, readNodePin, writeNodePin } from "@/lib/nodeHost";
import * as copy from "@/lib/nodeHostCopy";
import { NodeAddressSettings, NodeConfirmDialog, type ApplyNodeChange } from "@/chat/NodeAddressSettings";

const ADDRESS = "http://127.0.0.1:8000";
const ID_A = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN1";
const ID_B = "did:key:z6MkshLEhewnQcHAwXaLy4W5YYbXD14mrTY1sB49SEmewXN2";

afterAll(() => restoreDomBeforeReact());
const realStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const realFetch = globalThis.fetch;
let data: Map<string, string>;
let restoreDom: (() => void) | undefined;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let applied: (() => void)[];
let nodeAnswers: string | null;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const applyChange: ApplyNodeChange = async (apply) => { applied.push(apply); return true; };

async function render(platform: AppPlatform, hosts: string[]) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <PlatformContext.Provider value={platform}>
        <NodeAddressSettings config={{ hosts }} applyChange={applyChange} />
      </PlatformContext.Provider>,
    );
    await tick();
    await tick();
  });
}
const text = () => document.body.textContent ?? "";
const input = () => document.body.querySelector("input") as HTMLInputElement;
const button = (label: string) => [...document.body.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === label) as HTMLButtonElement | undefined;
const type = (value: string) => setValue(input(), value, act);
async function press(label: string) {
  expect(button(label), `missing ${label}; DOM=${document.body.innerHTML}`).toBeTruthy();
  await act(async () => { button(label)!.click(); await tick(); await tick(); });
}

beforeEach(() => {
  data = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } },
  });
  applied = [];
  nodeAnswers = ID_A;
  globalThis.fetch = (async () => nodeAnswers
    ? new Response(JSON.stringify({ nodeId: nodeAnswers }), { status: 200 })
    : Promise.reject(new TypeError("refused"))) as unknown as typeof fetch;
  restoreDom = installDom();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  await tick();
  root = null;
  host?.remove();
  host = null;
  restoreDom?.();
  if (realStorage) Object.defineProperty(globalThis, "localStorage", realStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
  globalThis.fetch = realFetch;
});

describe("the node address setting is a desktop-app setting", () => {
  for (const platform of ["web", "ios", "android"] as const) {
    it(`is not shown on ${platform}`, async () => {
      await render(platform, []);
      expect(host!.innerHTML).toBe("");
    });
  }

  it("is shown in the desktop app, with the default in use", async () => {
    await render("tauri", []);
    expect(text()).toContain(copy.NODE_SETTING_SECTION_LABEL);
    expect(text()).toContain(copy.NODE_STATUS_DEFAULT);
    expect(text()).toContain(copy.NODE_LIMITS_HEADING);
    expect(input().placeholder).toBe(copy.NODE_SETTING_PLACEHOLDER);
  });
});

describe("saving an address", () => {
  it("accepts only a loopback address", async () => {
    await render("tauri", []);
    expect(button(copy.NODE_SETTING_SAVE)!.disabled).toBe(true);
    for (const value of ["http://localhost:8000", "https://127.0.0.1:8000", "https://tee.node.tinycloud.xyz", "http://127.0.0.1", "127.0.0.1:8000", "http://10.0.0.5:8000"]) {
      await type(value);
      expect(button(copy.NODE_SETTING_SAVE)!.disabled, value).toBe(true);
    }
    await type("http://127.0.0.1:8000");
    expect(button(copy.NODE_SETTING_SAVE)!.disabled).toBe(false);
  });

  it("writes the address only after the session has been cleared, through the change callback", async () => {
    await render("tauri", []);
    await type(" http://127.0.0.1:9000/ ");
    await press(copy.NODE_SETTING_SAVE);
    expect(applied).toHaveLength(1);
    expect(data.has(NODE_HOST_STORAGE_KEY)).toBe(false);
    applied[0]!();
    expect(data.get(NODE_HOST_STORAGE_KEY)).toBe("http://127.0.0.1:9000");
  });

  it("does nothing to storage when the session cannot be cleared", async () => {
    let calls = 0;
    const refused: ApplyNodeChange = async () => { calls++; return false; };
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<PlatformContext.Provider value="tauri"><NodeAddressSettings config={{ hosts: [] }} applyChange={refused} /></PlatformContext.Provider>);
      await tick();
    });
    await type("http://127.0.0.1:9000");
    await press(copy.NODE_SETTING_SAVE);
    expect(calls).toBe(1);
    expect(data.size).toBe(0);
    expect(button(copy.NODE_SETTING_SAVE)!.disabled).toBe(false);
  });
});

describe("with a node address set", () => {
  it("shows the address and the saved ID, and 'Use the default' clears the address", async () => {
    data.set(NODE_HOST_STORAGE_KEY, ADDRESS);
    writeNodePin(ADDRESS, ID_A);
    await render("tauri", [ADDRESS]);
    expect(text()).toContain(copy.nodeStatusLocal(ADDRESS, copy.shortNodeId(ID_A)));
    expect(input().value).toBe(ADDRESS);
    await press(copy.NODE_SETTING_USE_DEFAULT);
    applied[0]!();
    expect(data.has(NODE_HOST_STORAGE_KEY)).toBe(false);
  });

  it("'Use the default' is off when the default is already in use", async () => {
    await render("tauri", []);
    expect(button(copy.NODE_SETTING_USE_DEFAULT)!.disabled).toBe(true);
  });

  it("with no saved ID yet, shows the ID the node is answering with, or that it cannot be reached", async () => {
    await render("tauri", [ADDRESS]);
    expect(text()).toContain(copy.nodeStatusLocal(ADDRESS, copy.shortNodeId(ID_A)));
    expect(button(copy.NODE_FORGET_BUTTON)).toBeUndefined();
    await act(async () => root!.unmount());
    root = null;
    host!.remove();
    nodeAnswers = null;
    await render("tauri", [ADDRESS]);
    expect(text()).toContain(copy.nodeUnreachable(ADDRESS));
  });

  it("forgetting names both IDs, then clears that address's saved ID through the change callback", async () => {
    writeNodePin(ADDRESS, ID_A);
    nodeAnswers = ID_B;
    await render("tauri", [ADDRESS]);
    await press(copy.NODE_FORGET_BUTTON);
    expect(text()).toContain(copy.NODE_FORGET_TITLE);
    expect(text()).toContain(copy.nodeForgetSavedLine(ID_A));
    expect(text()).toContain(copy.nodeForgetNowLine(ID_B));
    expect(text()).toContain(copy.nodeForgetSignOutLine(ADDRESS));
    expect(applied).toHaveLength(0);
    await press(copy.NODE_FORGET_CONFIRM);
    expect(applied).toHaveLength(1);
    expect(readNodePin(ADDRESS)).not.toBeNull();
    applied[0]!();
    expect(readNodePin(ADDRESS)).toBeNull();
  });

  it("leaves out the current ID when the node cannot be reached, and cancelling changes nothing", async () => {
    writeNodePin(ADDRESS, ID_A);
    nodeAnswers = null;
    await render("tauri", [ADDRESS]);
    await press(copy.NODE_FORGET_BUTTON);
    expect(text()).toContain(copy.nodeForgetSavedLine(ID_A));
    expect(text()).not.toContain("Now at this address");
    await press(copy.NODE_FORGET_CANCEL);
    expect(applied).toHaveLength(0);
    expect(readNodePin(ADDRESS)).not.toBeNull();
  });
});

describe("the first-use question", () => {
  it("shows the address, the full ID and the command to compare, and reports one answer", async () => {
    const answers: boolean[] = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<NodeConfirmDialog request={{ address: ADDRESS, nodeId: ID_A }} onDecide={(value) => answers.push(value)} />);
      await tick();
    });
    expect(text()).toContain(copy.NODE_CONFIRM_TITLE);
    expect(text()).toContain(copy.nodeConfirmBody(ADDRESS));
    expect(document.body.querySelector("[data-node-confirm-id]")!.textContent).toBe(ID_A);
    expect(document.body.querySelector("code")!.textContent).toBe(`curl ${ADDRESS}/info`);
    await press(copy.NODE_CONFIRM_CONFIRM);
    expect(answers[0]).toBe(true);
    expect(answers).not.toContain(undefined);
  });

  it("Cancel is a no", async () => {
    const answers: boolean[] = [];
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<NodeConfirmDialog request={{ address: ADDRESS, nodeId: ID_A }} onDecide={(value) => answers.push(value)} />);
      await tick();
    });
    await press(copy.NODE_CONFIRM_CANCEL);
    expect(answers[0]).toBe(false);
    expect(answers).not.toContain(true);
  });
});
