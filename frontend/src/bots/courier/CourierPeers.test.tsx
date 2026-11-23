import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installDom } from "@/test/dom";
import { BotsRouteMissing } from "../botsApi";
import type { CourierPeer, CourierPeersApi } from "./courierPeersApi";

// Radix portals do not attach in happy-dom. Match BotManage's test seam for dialog chrome;
// the confirmation copy, buttons and API workflow remain the real CourierPeers component.
const actualAlert = { ...(await import("@/components/ui/alert-dialog")) };
afterAll(() => { mock.module("@/components/ui/alert-dialog", () => actualAlert); });
mock.module("@/components/ui/alert-dialog", () => ({
  ...actualAlert,
  AlertDialog: (props: { open: boolean; children?: ReactNode }) => props.open ? <div role="alertdialog">{props.children}</div> : null,
  AlertDialogContent: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  AlertDialogHeader: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  AlertDialogTitle: (props: { children?: ReactNode }) => <h2>{props.children}</h2>,
  AlertDialogFooter: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
// Load the consumer after installing the module seam; a static import would bind the real portal first.
const { CourierPeers } = await import("./CourierPeers");

const PEER: CourierPeer = {
  handle: "agent.example", peerDid: "did:key:peer", status: "paired",
  pairedAt: Date.UTC(2026, 10, 23), delegationExpiresAt: Date.UTC(2026, 10, 30),
};
const PENDING = { acceptArtifact: "accept-code", pending: true as const, handle: PEER.handle, pendingExpiresAt: Date.now() + 900_000 };
let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

function fixture(overrides: Partial<CourierPeersApi> = {}) {
  const paired: { artifact: string }[] = [];
  const removed: string[] = [];
  const api: CourierPeersApi = {
    listPeers: async () => ({ peers: [] }),
    pairPeer: async (request) => {
      paired.push(request);
      return paired.length === 1 ? PENDING : { peer: PEER };
    },
    unpairPeer: async (handle) => { removed.push(handle); },
    ...overrides,
  };
  return { api, paired, removed };
}
const flush = () => act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); });
async function render(api: CourierPeersApi) {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);
  await act(async () => mounted!.render(<CourierPeers api={api} />));
  await flush();
  return host;
}
const button = (host: Element, label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
const click = async (host: Element, label: string) => { await act(async () => button(host, label).click()); await flush(); };
async function paste(host: Element, code = " pair-start-code ") {
  const input = host.querySelector<HTMLTextAreaElement>("textarea:not([readonly])")!;
  await act(async () => {
    input.focus();
    // happy-dom does not implement the browser's default paste insertion.
    input.dispatchEvent(new Event("paste", { bubbles: true }));
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "v", bubbles: true }));
  });
}
const date = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

test("paste, pair, copy and finish pairing only lists the agent after its final code", async () => {
  const { api, paired } = fixture();
  const host = await render(api);
  expect(host.textContent).toContain("No paired agents.");
  const copy = spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  try {
    await paste(host);
    await click(host, "Pair agent");
    expect(paired).toEqual([{ artifact: "pair-start-code" }]);
    expect(host.querySelector<HTMLTextAreaElement>("textarea[readonly]")!.value).toBe("accept-code");
    expect(host.textContent).toContain("Give this code to your agent. It sends back a final code.");
    expect(host.textContent).toContain(`This step expires at ${new Date(PENDING.pendingExpiresAt).toLocaleTimeString(undefined, { timeStyle: "short" })}.`);
    expect(host.textContent).toContain("Waiting for your agent's final code.");
    expect(host.textContent).toContain("No paired agents.");
    expect(host.querySelectorAll("li")).toHaveLength(0);
    await click(host, "Copy");
    expect(copy).toHaveBeenCalledWith("accept-code");
    expect(button(host, "Copied")).toBeDefined();
    await paste(host, " final-code ");
    await click(host, "Finish pairing");
    expect(paired).toEqual([{ artifact: "pair-start-code" }, { artifact: "final-code" }]);
    expect(host.textContent).toContain(PEER.handle);
    expect(host.textContent).toContain(`Paired until ${date(PEER.delegationExpiresAt)}`);
    expect(host.querySelector("textarea[readonly]")).toBeNull();
  } finally { copy.mockRestore(); }
});

test("unpair requires approval and removes only the selected peer after the API succeeds", async () => {
  const { api, removed } = fixture({ listPeers: async () => ({ peers: [PEER] }) });
  const host = await render(api);
  await click(host, "Unpair");
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(`Unpair ${PEER.handle}? TrustBot stops answering it.`);
  expect(removed).toEqual([]);
  await click(dialog, "Cancel");
  expect(host.textContent).toContain(PEER.handle);
  await click(host, "Unpair");
  await click(document.querySelector('[role="alertdialog"]')!, "Unpair");
  expect(removed).toEqual([PEER.handle]);
  expect(host.textContent).not.toContain(PEER.handle);
  expect(host.textContent).toContain("No paired agents.");
});

test("a failed pair preserves the pasted code and shows the approved error", async () => {
  const host = await render(fixture({ pairPeer: async () => { throw new Error("fixture"); } }).api);
  await paste(host);
  await click(host, "Pair agent");
  expect(host.querySelector("[role=alert]")!.textContent).toBe("This agent couldn't be paired. Check the code and try again.");
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value.trim()).toBe("pair-start-code");
  expect(host.querySelector("textarea[readonly]")).toBeNull();
});

test("a failed unpair retains the peer and shows the approved error", async () => {
  const host = await render(fixture({
    listPeers: async () => ({ peers: [PEER] }), unpairPeer: async () => { throw new Error("fixture"); },
  }).api);
  await click(host, "Unpair");
  await click(document.querySelector('[role="alertdialog"]')!, "Unpair");
  expect(host.textContent).toContain(PEER.handle);
  expect(document.querySelector("[role=alert]")!.textContent).toBe("This agent couldn't be unpaired. Try again.");
});

test("a clipboard failure leaves the accept code available for manual copying", async () => {
  const host = await render(fixture().api);
  const copy = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("fixture"));
  try {
    await paste(host);
    await click(host, "Pair agent");
    await click(host, "Copy");
    expect(host.querySelector("[role=alert]")!.textContent).toBe("The code couldn't be copied. Select it and copy it yourself.");
    expect(host.querySelector<HTMLTextAreaElement>("textarea[readonly]")!.value).toBe("accept-code");
  } finally { copy.mockRestore(); }
});

test("404 renders nothing", async () => {
  const host = await render(fixture({ listPeers: async () => { throw new BotsRouteMissing(); } }).api);
  expect(host.innerHTML).toBe("");
});

test("a failed load shows the approved load error", async () => {
  const host = await render(fixture({ listPeers: async () => { throw new Error("fixture"); } }).api);
  expect(host.querySelector("[role=alert]")!.textContent).toBe("Paired agents couldn't be loaded. Try again.");
});

test("a 404 during pairing hides the surface", async () => {
  const host = await render(fixture({ pairPeer: async () => { throw new BotsRouteMissing(); } }).api);
  await paste(host);
  await click(host, "Pair agent");
  expect(host.innerHTML).toBe("");
});

test("loading exposes the approved status and no enabled pairing controls", async () => {
  const host = await render(fixture({ listPeers: () => new Promise(() => {}) }).api);
  expect(host.querySelector("[role=status]")!.textContent).toBe("Loading paired agents…");
  expect(host.querySelector("form")).toBeNull();
});

test("pairing replaces an existing peer rather than creating duplicate rows", async () => {
  const host = await render(fixture({ listPeers: async () => ({ peers: [PEER] }) }).api);
  await paste(host);
  await click(host, "Pair agent");
  await paste(host, "final-code");
  await click(host, "Finish pairing");
  expect(host.querySelectorAll("li")).toHaveLength(1);
});

test("expired pending pairing cannot be finished and can be restarted", async () => {
  const { api, paired } = fixture({
    pairPeer: async (request) => { paired.push(request); return { ...PENDING, pendingExpiresAt: Date.now() - 1 }; },
  });
  const host = await render(api);
  await paste(host);
  await click(host, "Pair agent");
  expect(host.textContent).toContain("This pairing request expired. Start with a new pair code from your agent.");
  expect(host.querySelector("textarea[readonly]")).toBeNull();
  expect(button(host, "Finish pairing")).toBeUndefined();
  await click(host, "Start over");
  expect(host.textContent).not.toContain("This pairing request expired.");
  expect(button(host, "Pair agent")).toBeDefined();
  expect(paired).toHaveLength(1);
});

test("a failed final code keeps the accept code and final input for correction", async () => {
  let attempts = 0;
  const host = await render(fixture({
    pairPeer: async () => {
      if (attempts++ === 0) return PENDING;
      throw new Error("fixture");
    },
  }).api);
  await paste(host);
  await click(host, "Pair agent");
  await paste(host, "invalid-final-code");
  await click(host, "Finish pairing");
  expect(host.querySelector("[role=alert]")!.textContent).toBe("This agent couldn't be paired. Check the code and try again.");
  expect(host.querySelector<HTMLTextAreaElement>("textarea[readonly]")!.value).toBe("accept-code");
  expect(host.querySelector<HTMLTextAreaElement>("textarea:not([readonly])")!.value).toBe("invalid-final-code");
  expect(host.querySelectorAll("li")).toHaveLength(0);
});

test("unpair leaves other paired agents intact", async () => {
  const other = { ...PEER, handle: "other.example", peerDid: "did:key:other" };
  const { api, removed } = fixture({ listPeers: async () => ({ peers: [PEER, other] }) });
  const host = await render(api);
  await click(host.querySelector("li")!, "Unpair");
  await click(document.querySelector('[role="alertdialog"]')!, "Unpair");
  expect(removed).toEqual([PEER.handle]);
  expect(host.querySelectorAll("li")).toHaveLength(1);
  expect(host.textContent).toContain(other.handle);
  expect(host.textContent).not.toContain(PEER.handle);
});
