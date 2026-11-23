import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { LEGACY_KEYS_BODY, LEGACY_KEYS_DECLINED, LEGACY_KEYS_TITLE } from "@/lib/homeStrings";
import { LegacyConnectorKeys } from "./LegacyConnectorKeys";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const BUILD_FLAG = "VITE_CONNECTOR_NAMED_KEY_WRITES";
const buildEnv = import.meta.env as Record<string, unknown>;

let restoreDom: () => void;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  buildEnv[BUILD_FLAG] = "true";
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
  delete buildEnv[BUILD_FLAG];
});

function tcwWith(status: "pending" | "already") {
  const asked: unknown[] = [];
  const fake = {
    secrets: { vault: { resealToKey: async () => ({ status }) } },
    kv: {},
    requestPermissions: async (permissions: unknown) => { asked.push(permissions); return { approved: false }; },
  };
  return { tcw: fake as unknown as TinyCloudWeb, asked };
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === label);

test("the card shows while a connector key is on the whole network, and Not now leaves it for the next time Connectors opens", async () => {
  const { tcw, asked } = tcwWith("pending");
  await act(async () => root.render(<LegacyConnectorKeys tcw={tcw} address={ADDRESS} />));
  await settle();
  expect(host.textContent).toContain(LEGACY_KEYS_TITLE);
  expect(host.textContent).toContain(LEGACY_KEYS_BODY);
  await act(async () => { button("Not now")!.click(); });
  expect(host.textContent).toContain(LEGACY_KEYS_DECLINED);
  expect(asked).toEqual([]);
  // The next open probes again, and the same stored state shows the card again.
  await act(async () => root.render(null));
  await act(async () => root.render(<LegacyConnectorKeys tcw={tcw} address={ADDRESS} />));
  await settle();
  expect(host.textContent).toContain(LEGACY_KEYS_BODY);
});

test("nothing is shown when no key is on the whole network, or when Connectors does not use its own keys", async () => {
  await act(async () => root.render(<LegacyConnectorKeys tcw={tcwWith("already").tcw} address={ADDRESS} />));
  await settle();
  expect(host.textContent).toBe("");
  delete buildEnv[BUILD_FLAG];
  await act(async () => root.render(<LegacyConnectorKeys tcw={tcwWith("pending").tcw} address={ADDRESS} />));
  await settle();
  expect(host.textContent).toBe("");
});
