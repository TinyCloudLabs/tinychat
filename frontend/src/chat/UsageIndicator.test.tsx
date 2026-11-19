import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { BillingStatus } from "@/lib/billingApi";
import { installDom } from "@/test/dom";
import { UsageIndicator } from "./UsageIndicator";

const status: BillingStatus = { tier: "free", usage: { used: 1200, limit: 5000, resetsAt: "" }, subscription: null };

let restoreDom: (() => void) | undefined;
let root: Root | undefined;
let host: HTMLElement;

beforeEach(() => {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  restoreDom?.();
});

describe("UsageIndicator", () => {
  test("web and desktop: the chip opens the plans", async () => {
    const opened: string[] = [];
    await act(async () => root!.render(<UsageIndicator status={status} tierName={null} onClick={() => opened.push("plans")} onOpenRates={() => {}} />));
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label="View plans and usage"]')!;
    await act(async () => chip.click());
    expect(opened).toEqual(["plans"]);
  });

  test("iOS and Android (no onClick): the chip shows usage only and a tap opens the usage details, never the plans", async () => {
    await act(async () => root!.render(<UsageIndicator status={status} tierName={null} onOpenRates={() => {}} />));
    expect(host.querySelector('button[aria-label="View plans and usage"]')).toBeNull();
    expect(host.textContent).not.toContain("Plans");
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label="Usage"]')!;
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    await act(async () => chip.click());
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[aria-label="Usage and plan details"]')?.textContent).toContain("1,200 / ");
  });
});
