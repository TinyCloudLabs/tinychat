// The build line's formatter (TC-840): `Exo <version> (<build>) · <target> ·
// <channel> · <app id> · <short sha>`, each segment from a real source and
// left out when its source has nothing to say.
import { describe, expect, test } from "bun:test";

import { channelOf, formatBuildInfo, targetLabel } from "./buildInfo";

describe("formatBuildInfo", () => {
  test("a native dev build: version, build number, target, channel, bundle id, short sha", () => {
    expect(
      formatBuildInfo({
        version: "0.6.0-beta.13",
        build: "160",
        target: "android",
        appId: "xyz.tinycloud.exo.dev",
        commit: "abc1234def5678",
      }),
    ).toBe("Exo 0.6.0-beta.13 (160) · android · dev · xyz.tinycloud.exo.dev · abc1234");
  });

  test("web without a build number: no empty parens", () => {
    expect(formatBuildInfo({ version: "0.6.0-beta.13", target: "web", commit: "67b1c77" })).toBe(
      "Exo 0.6.0-beta.13 · web · beta · 67b1c77",
    );
  });

  test("a stable release reports the stable channel", () => {
    expect(formatBuildInfo({ version: "0.6.0", target: "ios", appId: "xyz.tinycloud.exo" })).toBe(
      "Exo 0.6.0 · ios · stable · xyz.tinycloud.exo",
    );
  });

  test("an iOS beta archive keeps the beta label: the injected marketing version, not the bundle's stripped one", () => {
    // CFBundleShortVersionString is "0.6.0" for a 0.6.0-beta.13 TestFlight
    // archive; the resolver feeds App.getInfo()'s build and id while the
    // define's full version and channel name the release.
    expect(
      formatBuildInfo({
        version: "0.6.0-beta.13",
        build: "1042",
        target: "ios",
        channel: "beta",
        appId: "xyz.tinycloud.exo",
        commit: "deadbeef99",
      }),
    ).toBe("Exo 0.6.0-beta.13 (1042) · ios · beta · xyz.tinycloud.exo · deadbee");
  });

  test("a desktop build carries its CFBundleVersion", () => {
    expect(
      formatBuildInfo({ version: "0.6.0-beta.13", build: "600013", target: "desktop-macos", appId: "xyz.tinycloud.exo" }),
    ).toBe("Exo 0.6.0-beta.13 (600013) · desktop-macos · beta · xyz.tinycloud.exo");
  });

  test("nothing is invented: missing sources leave segments out", () => {
    expect(formatBuildInfo({ target: "web" })).toBe("Exo unknown · web");
    expect(formatBuildInfo({})).toBe("Exo unknown");
    // Whitespace-only fields are absent too.
    expect(formatBuildInfo({ version: "  ", build: " ", commit: " ", appId: "  " })).toBe("Exo unknown");
  });

  test("a seven-character sha is kept as is; longer ones are cut to seven", () => {
    expect(formatBuildInfo({ version: "1.0.0", commit: "1234567" })).toContain("· 1234567");
    expect(formatBuildInfo({ version: "1.0.0", commit: "1234567890abcdef" })).toContain("· 1234567");
  });
});

describe("channelOf", () => {
  test("the pipeline's own word wins over the version's", () => {
    expect(channelOf({ channel: "beta", version: "0.6.0" })).toBe("beta");
    expect(channelOf({ channel: "stable", version: "0.6.0-beta.13" })).toBe("stable");
    expect(channelOf({ channel: "nightly" as string, version: "0.6.0-beta.13" })).toBe("beta");
  });

  test("derived from the version or the bundle id when unsaid", () => {
    expect(channelOf({ version: "0.6.0-beta.13" })).toBe("beta");
    expect(channelOf({ version: "0.6.0", appId: "xyz.tinycloud.exo.dev" })).toBe("dev");
    expect(channelOf({ version: "0.6.0" })).toBe("stable");
    expect(channelOf({})).toBeUndefined();
  });
});

describe("targetLabel", () => {
  test("the desktop app ships for macOS only; the rest name themselves", () => {
    expect(targetLabel("tauri")).toBe("desktop-macos");
    expect(targetLabel("ios")).toBe("ios");
    expect(targetLabel("android")).toBe("android");
    expect(targetLabel("web")).toBe("web");
  });
});
