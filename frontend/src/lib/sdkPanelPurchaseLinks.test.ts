import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installDom } from "@/test/dom";
import { hideSdkPurchaseLinks, PHONE_STORAGE_FULL_TEXT, SDK_STORAGE_FULL_TEXT } from "./sdkPanelPurchaseLinks";

let restoreDom: (() => void) | undefined;
let stop: (() => void) | undefined;

beforeEach(() => { restoreDom = installDom(); });
afterEach(() => {
  stop?.();
  stop = undefined;
  restoreDom?.();
});

/** The SDK's host as @tinycloud/web-sdk renders it: an open shadow root on a child of <body>, with the panel's Storage link and toasts. */
function sdkHost(): ShadowRoot {
  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<div class="layer">
    <section class="storage"><div class="storage-link"><a class="storage-manage" href="https://account.tinycloud.xyz/storage" target="_blank">Manage storage</a></div></section>
    <div class="toasts"><div class="toast toast--info"><div class="toast__message">${SDK_STORAGE_FULL_TEXT}</div><a href="https://billing.example/storage" target="_blank">Manage storage</a></div></div>
    <a class="docs" href="https://docs.tinycloud.xyz" target="_blank">Docs</a>
  </div>`;
  document.body.append(host);
  return root;
}

function hiddenBySheet(root: ShadowRoot, element: Element): boolean {
  const sheet = root.querySelector("style")?.textContent ?? "";
  const selectors = sheet.slice(0, sheet.indexOf("{")).split(",").map((selector) => selector.trim());
  return selectors.some((selector) => element.matches(selector));
}

describe("hideSdkPurchaseLinks", () => {
  test("hides the panel's Storage link and the storage-full toast's link, and drops 'or upgrade' from its sentence", () => {
    const root = sdkHost();
    stop = hideSdkPurchaseLinks();
    const manage = root.querySelector("a.storage-manage")!;
    const toastLink = root.querySelector(".toast a")!;
    expect(hiddenBySheet(root, manage)).toBe(true);
    expect(hiddenBySheet(root, toastLink)).toBe(true);
    expect(root.querySelector(".toast__message")!.textContent).toBe(PHONE_STORAGE_FULL_TEXT);
    expect(PHONE_STORAGE_FULL_TEXT).toContain("Manage your plan on the web at tinycloud.xyz.");
    expect(root.textContent).not.toContain("upgrade");
    expect(hiddenBySheet(root, root.querySelector("a.docs")!)).toBe(false);
  });

  test("covers a host the SDK adds later and a toast it renders after that", async () => {
    stop = hideSdkPurchaseLinks();
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    document.body.append(host);
    await Promise.resolve();
    expect(root.querySelector("style")).not.toBeNull();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<div class="toast__message">${SDK_STORAGE_FULL_TEXT}</div><a href="https://account.tinycloud.xyz/storage">Manage storage</a>`;
    root.append(toast);
    await Promise.resolve();
    expect(toast.querySelector(".toast__message")!.textContent).toBe(PHONE_STORAGE_FULL_TEXT);
    expect((toast.querySelector("a") as HTMLAnchorElement).hidden).toBe(true);
  });

  test("the installed SDK still renders the string and classes this relies on", () => {
    const sdkDist = dirname(fileURLToPath(import.meta.resolve("@tinycloud/web-sdk")));
    const panel = readFileSync(join(sdkDist, "panel.mjs"), "utf8");
    expect(panel).toContain(`"storage.full":"${SDK_STORAGE_FULL_TEXT}"`);
    expect(panel).toContain('"storage-link"');
    expect(panel).toContain('"storage-manage"');
    const index = readFileSync(join(sdkDist, "index.mjs"), "utf8");
    expect(index).toContain('attachShadow({mode:"open"})');
    expect(index).toContain('className="toast__message"');
  });
});
