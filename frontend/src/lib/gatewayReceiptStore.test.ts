import { afterEach, expect, test } from "bun:test";
import { clearGatewayReceipt, getGatewayReceiptVerified, onGatewayReceipt, setGatewayReceiptVerified } from "./gatewayReceiptStore.js";

afterEach(() => clearGatewayReceipt("assistant-1"));

test("only an explicit verified receipt creates a reply mark", () => {
  const changes: boolean[] = [];
  const unsubscribe = onGatewayReceipt("assistant-1", () => changes.push(getGatewayReceiptVerified("assistant-1")));
  try {
    expect(getGatewayReceiptVerified("assistant-1")).toBe(false);
    // Failed and unfinished streams have no verified event and remain unmarked.
    expect(changes).toEqual([]);
    setGatewayReceiptVerified("assistant-1");
    expect(getGatewayReceiptVerified("assistant-1")).toBe(true);
    expect(changes).toEqual([true]);
    clearGatewayReceipt("assistant-1");
    expect(getGatewayReceiptVerified("assistant-1")).toBe(false);
    expect(changes).toEqual([true, false]);
  } finally {
    unsubscribe();
  }
});
