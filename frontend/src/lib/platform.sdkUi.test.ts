import { describe, expect, test } from "bun:test";
import { sdkUiPlatform } from "./platform";

describe("sdkUiPlatform", () => {
  test("the phone and desktop apps get the native panel, a browser the web one", () => {
    expect(sdkUiPlatform("ios")).toBe("native");
    expect(sdkUiPlatform("android")).toBe("native");
    expect(sdkUiPlatform("tauri")).toBe("native");
    expect(sdkUiPlatform("web")).toBe("web");
  });
});
