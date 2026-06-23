import { describe, expect, mock, test } from "bun:test";

import { healPersistedModel, sanitizeModel } from "./sanitizeModel";
import { DEFAULT_MODEL } from "./threadStore";

describe("sanitizeModel (ST1)", () => {
  const OFFERED = new Set(["phala/gpt-oss-120b", "phala/gpt-oss-20b"]);

  test("keeps an id that is in the offered set", () => {
    expect(sanitizeModel("phala/gpt-oss-20b", OFFERED)).toBe("phala/gpt-oss-20b");
  });

  test("heals a non-offered id to the fallback when the offered set is loaded", () => {
    // A stale pre-PR id present in localStorage/SQL must NOT survive once the
    // offered list is known.
    expect(sanitizeModel("openai/gpt-5-mini", OFFERED)).toBe(DEFAULT_MODEL);
    // A phala/ id that simply isn't offered is also corrected away.
    expect(sanitizeModel("phala/not-in-catalog", OFFERED)).toBe(DEFAULT_MODEL);
  });

  test("null/empty heals to the fallback", () => {
    expect(sanitizeModel(null, OFFERED)).toBe(DEFAULT_MODEL);
    expect(sanitizeModel("", OFFERED)).toBe(DEFAULT_MODEL);
    expect(sanitizeModel(undefined, OFFERED)).toBe(DEFAULT_MODEL);
  });

  test("respects a custom fallback", () => {
    expect(sanitizeModel("openai/gpt-5-mini", OFFERED, "phala/gpt-oss-20b")).toBe(
      "phala/gpt-oss-20b",
    );
  });

  test("before the offered list loads (empty set), falls back to the TEE-capable membership gate", () => {
    const EMPTY = new Set<string>();
    // A non-offered legacy id is rejected for instant paint.
    expect(sanitizeModel("openai/gpt-5-mini", EMPTY)).toBe(DEFAULT_MODEL);
    // A stale phala/ id (no longer in the offered membership set) is also rejected.
    expect(sanitizeModel("phala/anything", EMPTY)).toBe(DEFAULT_MODEL);
    // An offered (TEE-capable) id is kept (instant-paint constraint).
    expect(sanitizeModel("qwen/qwen-2.5-7b-instruct", EMPTY)).toBe("qwen/qwen-2.5-7b-instruct");
  });

  test("before the offered list loads, still heals known blocklisted phala ids", () => {
    const EMPTY = new Set<string>();
    expect(sanitizeModel("phala/glm-4.7", EMPTY)).toBe(DEFAULT_MODEL);
    expect(healPersistedModel("phala/glm-4.7", EMPTY)).toEqual({
      model: DEFAULT_MODEL,
      healed: true,
    });
  });

  test("accepts an array as the offered collection", () => {
    expect(sanitizeModel("phala/gpt-oss-120b", ["phala/gpt-oss-120b"])).toBe(
      "phala/gpt-oss-120b",
    );
    expect(sanitizeModel("openai/gpt-5", ["phala/gpt-oss-120b"])).toBe(DEFAULT_MODEL);
  });
});

// healPersistedModel is the heal decision shared by both restore paths. The App
// SQL-restore effect and the runtime thread-model sync persist the correction
// (App: pickModel → setSetting("active_model"); runtime: setThreadModel) iff
// `healed`. These tests drive that exact branch through the shared helper so the
// self-healing write-back ("second sign-in surfaces no stale value") is covered.
describe("healPersistedModel — ST1 write-back decision", () => {
  const OFFERED = new Set(["phala/gpt-oss-120b", "phala/gpt-oss-20b"]);

  test("stale SQL active_model heals to DEFAULT_MODEL and signals a write-back", () => {
    const decision = healPersistedModel("openai/gpt-5-mini", OFFERED);
    expect(decision).toEqual({ model: DEFAULT_MODEL, healed: true });
  });

  test("an already-offered value needs no write-back", () => {
    const decision = healPersistedModel("phala/gpt-oss-20b", OFFERED);
    expect(decision).toEqual({ model: "phala/gpt-oss-20b", healed: false });
  });

  test("App restore: pickModel persists the corrected active_model only when healed", () => {
    // Mirror App.tsx pickModel: setSelectedModel + writeLocalModel + setSetting.
    const setSetting = mock((_key: string, _value: string) => {});
    const writeLocalModel = mock((_value: string) => {});
    const pickModel = (next: string) => {
      writeLocalModel(next);
      setSetting("active_model", next);
    };

    const stale = "openai/gpt-5-mini";
    const { model: corrected, healed } = healPersistedModel(stale, OFFERED);
    if (healed) pickModel(corrected);

    expect(healed).toBe(true);
    expect(setSetting).toHaveBeenCalledWith("active_model", DEFAULT_MODEL);
    expect(writeLocalModel).toHaveBeenCalledWith(DEFAULT_MODEL);
  });

  test("App restore: a valid saved value is NOT written back via pickModel", () => {
    const setSetting = mock((_key: string, _value: string) => {});
    const { model: corrected, healed } = healPersistedModel("phala/gpt-oss-120b", OFFERED);
    if (healed) setSetting("active_model", corrected);
    expect(setSetting).not.toHaveBeenCalled();
  });

  test("runtime restore: setThreadModel heals a stale pre-PR thread row", () => {
    // The runtime sync runs before /models loads, so the offered set is empty and
    // the TEE-capable membership gate applies (a non-offered legacy id is rejected).
    const EMPTY = new Set<string>();
    const setThreadModel = mock((_threadId: string, _value: string) => {});
    const threadId = "thread-1";

    const { model: corrected, healed } = healPersistedModel("openai/gpt-5-mini", EMPTY);
    if (healed) setThreadModel(threadId, corrected);

    expect(healed).toBe(true);
    expect(corrected).toBe(DEFAULT_MODEL);
    expect(setThreadModel).toHaveBeenCalledWith(threadId, DEFAULT_MODEL);
  });

  test("runtime restore: an offered thread row is kept and not rewritten pre-load", () => {
    const EMPTY = new Set<string>();
    const setThreadModel = mock((_threadId: string, _value: string) => {});
    const { model: corrected, healed } = healPersistedModel("qwen/qwen-2.5-7b-instruct", EMPTY);
    if (healed) setThreadModel("thread-1", corrected);
    expect(corrected).toBe("qwen/qwen-2.5-7b-instruct");
    expect(setThreadModel).not.toHaveBeenCalled();
  });
});
