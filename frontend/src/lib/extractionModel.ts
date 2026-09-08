import { isOfferedChatModel, type OfferedModelId } from "@tinyboilerplate/core";

/** Validate the immutable model captured at the turn barrier. */
export function pickExtractionModel(model: string): OfferedModelId {
  if (!isOfferedChatModel(model)) {
    throw new Error(`Extraction model is not offered: ${model}`);
  }
  return model;
}
