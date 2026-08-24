import { describe, expect, test } from "bun:test";

import {
  isResponseVerifiableModel,
  isTeeCapableModel,
} from "./completionStore";

describe("model verification capabilities", () => {
  test("GLM 5.2 is TEE-capable without claiming response signatures", () => {
    expect(isTeeCapableModel("z-ai/glm-5.2")).toBe(true);
    expect(isResponseVerifiableModel("z-ai/glm-5.2")).toBe(false);
  });

  test("retains the previously confirmed DeepSeek response-signature capability", () => {
    expect(isTeeCapableModel("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isResponseVerifiableModel("deepseek/deepseek-v4-flash")).toBe(true);
  });
});
