import { describe, expect, test } from "bun:test";

import { savesMomentOnBeforeInput } from "./MomentField";

describe("Gboard moment submission", () => {
  test("the composing Enter keydown is followed by an accepted paragraph beforeinput", () => {
    const sequence = [
      { type: "keydown", key: "Enter", isComposing: true },
      { type: "compositionend" },
      { type: "beforeinput", inputType: "insertParagraph" },
    ];
    const keydown = sequence[0]!;
    expect(keydown.type === "keydown" && keydown.key === "Enter" && keydown.isComposing).toBe(true);
    expect(savesMomentOnBeforeInput(sequence[2]!.inputType!)).toBe(true);
  });

  test("line breaks are accepted and ordinary input is ignored", () => {
    expect(savesMomentOnBeforeInput("insertLineBreak")).toBe(true);
    expect(savesMomentOnBeforeInput("insertText")).toBe(false);
  });
});
