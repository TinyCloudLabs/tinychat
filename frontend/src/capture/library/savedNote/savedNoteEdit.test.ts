import { describe, expect, test } from "bun:test";
import {
  discardChanges,
  isDirty,
  isEditing,
  keepEditing,
  NOT_EDITING,
  requestCancel,
  requestClose,
  saved,
  startEdit,
  typeInto,
} from "./savedNoteEdit";

describe("saved note edit", () => {
  test("Edit opens the editor on the saved note", () => {
    const fields = startEdit(NOT_EDITING, "hello");
    expect(fields).toEqual({ draft: "hello", confirming: null });
    expect(isEditing(fields)).toBe(true);
    expect(isDirty(fields, "hello")).toBe(false);
  });

  test("Edit again resumes the draft kept from an earlier visit", () => {
    expect(startEdit({ draft: "kept", confirming: null }, "hello").draft).toBe("kept");
  });

  test("Cancel with no changes leaves Edit at once", () => {
    expect(requestCancel(startEdit(NOT_EDITING, "hello"), "hello")).toEqual(NOT_EDITING);
  });

  test("Cancel with changes asks first; keeping goes back to editing", () => {
    const typed = typeInto(startEdit(NOT_EDITING, "hello"), "hello world");
    const asked = requestCancel(typed, "hello");
    expect(asked).toEqual({ draft: "hello world", confirming: "cancel" });
    expect(keepEditing(asked)).toEqual({ draft: "hello world", confirming: null });
  });

  test("discarding leaves Edit and does not close the sheet when it was Cancel", () => {
    const asked = requestCancel(typeInto(startEdit(NOT_EDITING, "a"), "b"), "a");
    expect(discardChanges(asked)).toEqual({ fields: NOT_EDITING, close: false });
  });

  test("closing the sheet with changes asks; discarding then closes it", () => {
    const typed = typeInto(startEdit(NOT_EDITING, "a"), "b");
    const result = requestClose(typed, "a");
    expect(result.close).toBe(false);
    expect(result.fields.confirming).toBe("close");
    expect(discardChanges(result.fields)).toEqual({ fields: NOT_EDITING, close: true });
  });

  test("closing the sheet with nothing to lose closes it", () => {
    expect(requestClose(NOT_EDITING, "a")).toEqual({ fields: NOT_EDITING, close: true });
    expect(requestClose(startEdit(NOT_EDITING, "a"), "a")).toEqual({ fields: NOT_EDITING, close: true });
  });

  test("typing outside Edit does nothing; saving ends Edit", () => {
    expect(typeInto(NOT_EDITING, "x")).toEqual(NOT_EDITING);
    expect(saved()).toEqual(NOT_EDITING);
  });
});
