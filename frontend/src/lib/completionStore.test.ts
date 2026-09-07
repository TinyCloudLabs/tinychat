import { describe, expect, test } from "bun:test";

import {
  isResponseVerifiableModel,
  isTeeCapableModel,
} from "./completionStore";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";

describe("model verification capabilities", () => {
  test("all offered models are TEE-capable without inferred response signatures", () => {
    for (const { id } of OFFERED_CHAT_MODELS) {
      expect(isTeeCapableModel(id)).toBe(true);
      expect(isResponseVerifiableModel(id)).toBe(false);
    }
  });

  test("retains the previously confirmed DeepSeek response-signature capability", () => {
    expect(isTeeCapableModel("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isResponseVerifiableModel("deepseek/deepseek-v4-flash")).toBe(true);
  });
});
