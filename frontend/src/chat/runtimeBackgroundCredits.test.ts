import { afterAll, describe, expect, test } from "bun:test";
import { stubSdkDomGlobals } from "../test/sdkDomGlobals";

const restoreSdkGlobals = stubSdkDomGlobals();
const initialHTMLElement = globalThis.HTMLElement;
const hadInitialHTMLElement = Object.hasOwn(globalThis, "HTMLElement");
const initialCustomElements = globalThis.customElements;
const hadInitialCustomElements = Object.hasOwn(globalThis, "customElements");
(globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement ??= class {} as never;
(globalThis as { customElements?: CustomElementRegistry }).customElements ??= {
  define: () => {},
  get: () => undefined,
  getName: () => undefined,
  upgrade: () => {},
  whenDefined: async () => undefined,
} as never;

// runtime.tsx transitively evaluates browser SDK modules, so these known modules
// must load after the DOM globals above are installed.

const { getReceipt, setReceipt } = await import("../lib/billingApi");
const { foldBackgroundCredits } = await import("./runtime");
restoreSdkGlobals();

afterAll(() => {
  if (hadInitialHTMLElement) globalThis.HTMLElement = initialHTMLElement;
  else delete (globalThis as { HTMLElement?: typeof HTMLElement }).HTMLElement;
  if (hadInitialCustomElements) globalThis.customElements = initialCustomElements;
  else delete (globalThis as { customElements?: CustomElementRegistry }).customElements;
});

describe("settled memory-extraction credits", () => {
  test("refreshes billing status once after the badge contains visible plus background credits", async () => {
    const userMessageId = `tc2002-user-${crypto.randomUUID()}`;
    const assistantMessageId = `tc2002-assistant-${crypto.randomUUID()}`;
    setReceipt(userMessageId, 2, "input");
    setReceipt(assistantMessageId, 4, "output");

    let refreshes = 0;
    let totalAtRefresh = 0;
    const deps = {
      onBackgroundUsageSettled: () => {
        refreshes += 1;
        totalAtRefresh =
          (getReceipt(userMessageId)?.credits ?? 0) +
          (getReceipt(assistantMessageId)?.credits ?? 0);
      },
    } as never;

    await foldBackgroundCredits(
      deps,
      "qwen/qwen3.6-35b-a3b",
      { promptTokens: 100, completionTokens: 1_000 },
      { userMessageId, assistantMessageId },
      {
        baseline: "qwen/qwen3.6-35b-a3b",
        models: [{
          id: "qwen/qwen3.6-35b-a3b",
          creditsPerKInput: 2,
          creditsPerKOutput: 10,
          multiplier: 1,
        }],
      },
    );

    expect(refreshes).toBe(1);
    expect(totalAtRefresh).toBe(17);
    expect(getReceipt(assistantMessageId)).toEqual({
      credits: 15,
      side: "output",
      includesUpkeep: true,
    });
  });
});
