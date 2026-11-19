import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { googleRefreshGrant, encodeDesktopRefreshToken } from "./googleOAuthDesktop";

describe("Google desktop OAuth", () => {
  test("keeps the Desktop client identity with its stored refresh token", () => {
    expect(googleRefreshGrant(encodeDesktopRefreshToken("refresh-1")))
      .toEqual({ refreshToken: "refresh-1", client: "desktop" });
    expect(googleRefreshGrant("legacy-web-refresh"))
      .toEqual({ refreshToken: "legacy-web-refresh" });
  });

  test("Tauri branches before the popup call", () => {
    const source = readFileSync(new URL("../../chat/ConnectorDialog.tsx", import.meta.url), "utf8");
    const handler = source.slice(source.indexOf("const handleAuthorize = useCallback"), source.indexOf("/**\n   * The callback listener"));
    const tauri = handler.indexOf('appPlatform() === "tauri"');
    const popup = handler.indexOf("window.open(");
    expect(tauri).toBeGreaterThanOrEqual(0);
    expect(popup).toBeGreaterThan(tauri);
    expect(handler.slice(tauri, popup)).toContain("return;");
  });
});
