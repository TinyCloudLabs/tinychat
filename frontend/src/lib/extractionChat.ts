import type { OfferedModelId } from "@tinyboilerplate/core";
import {
  completeChat,
  type BackgroundReasoningPreference,
  type StreamChatOptions,
} from "./chatApi";

const EXTRACTION_REASONING: Record<OfferedModelId, BackgroundReasoningPreference> = {
  "moonshotai/kimi-k3": "minimal",
  "z-ai/glm-5.3": "minimal",
  "z-ai/glm-5.2": "off",
  "qwen/qwen3.6-35b-a3b": "off",
};

/** Run memory extraction with the cheapest reasoning mode each offered family supports. */
export function completeExtractionChat(
  options: Omit<StreamChatOptions, "reasoning"> & { model: OfferedModelId },
): Promise<string> {
  return completeChat({
    ...options,
    reasoning: EXTRACTION_REASONING[options.model],
  });
}
