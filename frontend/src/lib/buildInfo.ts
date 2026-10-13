// One muted line of build provenance (TC-840) — target, marketing version,
// build number and commit — shown at the foot of the boot surface, the
// desktop sidebar and the bottom of Settings, in every build.
//
// Sources, by target:
//   web            `__EXO_BUILD_INFO__`, injected by vite.config.ts
//                  (frontend/package.json's version — the fixed web/desktop/
//                  mobile version the release pipeline owns — plus the commit
//                  and channel the build was cut from)
//   ios / android  the injected marketing version and channel (the archive
//                  strips "-beta.N" from CFBundleShortVersionString, so the
//                  bundle's own version string cannot tell beta from stable),
//                  with Capacitor App.getInfo() supplying the bundle id and
//                  build number and standing in for any missing baseline
//   desktop-macos  Tauri's app version and identifier, plus the pipeline's
//                  VITE_EXO_BUILD_NUMBER (CFBundleVersion) when it was set
//
// Nothing is hard-coded: a missing source leaves the segment out rather than
// inventing a value.
import { App as CapacitorApp, type AppInfo } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";

import type { AppPlatform } from "./platform";

/** What `formatBuildInfo` renders; every field but the target is optional. */
export interface BuildInfoInput {
  /** Marketing version, e.g. "0.6.0-beta.13". */
  version?: string;
  /** Build number (Android versionCode, iOS/desktop CFBundleVersion). */
  build?: string;
  /** web | ios | android | desktop-macos. */
  target?: string;
  /** Native bundle id; tells a .dev install apart from production. */
  appId?: string;
  /** Git sha of the built commit; long shas are shortened. */
  commit?: string;
  /** Release channel when the pipeline knows it; derived otherwise. */
  channel?: string;
}

/** The label each AppPlatform prints: the desktop app is macOS only. */
export function targetLabel(platform: AppPlatform): string {
  return platform === "tauri" ? "desktop-macos" : platform;
}

/** dev | beta | stable, from the channel a build says it is, else the bundle id and the version. */
export function channelOf(info: Pick<BuildInfoInput, "channel" | "version" | "appId">): string | undefined {
  const channel = info.channel?.trim();
  if (channel === "dev" || channel === "beta" || channel === "stable") return channel;
  // A .dev-signed install is a dev build even when the version it carries is a beta.
  if (/(^|\.)dev$/.test(info.appId?.trim() ?? "")) return "dev";
  if (/-beta[.\d]*$/.test(info.version?.trim() ?? "")) return "beta";
  if (info.version?.trim()) return "stable";
  return undefined;
}

/** `Exo 0.6.0-beta.13 (160) · android · dev · xyz.tinycloud.exo.dev · abc1234`. */
export function formatBuildInfo(info: BuildInfoInput): string {
  const version = info.version?.trim();
  const build = info.build?.trim();
  const head = `Exo ${version || "unknown"}${build ? ` (${build})` : ""}`;
  const parts = [head];
  if (info.target?.trim()) parts.push(info.target.trim());
  const channel = channelOf(info);
  if (channel) parts.push(channel);
  if (info.appId?.trim()) parts.push(info.appId.trim());
  const commit = info.commit?.trim();
  if (commit) parts.push(commit.length > 7 ? commit.slice(0, 7) : commit);
  return parts.join(" · ");
}

/** The web/desktop/mobile baseline vite.config.ts bakes into every bundle. */
const INJECTED: { version?: string; commit?: string; build?: string; channel?: string } =
  typeof __EXO_BUILD_INFO__ === "object" && __EXO_BUILD_INFO__ !== null ? __EXO_BUILD_INFO__ : {};

/** Harnesses and tests only: stands in for the installed app's getInfo(). */
let appInfoForTests: Pick<AppInfo, "version" | "build" | "id"> | null = null;
export function __setBuildInfoForTests(info: Pick<AppInfo, "version" | "build" | "id"> | null): void {
  appInfoForTests = info;
}

/**
 * The line for the platform it is shown on. On native the marketing version
 * and channel come from the injected baseline — the bundle's own version is
 * normalized (a TestFlight archive reports 0.6.0 for 0.6.0-beta.13) — and the
 * bundle supplies only what the baseline cannot know: the id and build
 * number, plus fallback values when the baseline is absent (a browser capture
 * running as "ios").
 */
export async function resolveBuildInfo(platform: AppPlatform): Promise<string> {
  const base = INJECTED;
  const target = targetLabel(platform);

  if (platform === "ios" || platform === "android") {
    const info = appInfoForTests ?? (Capacitor.isNativePlatform() ? await CapacitorApp.getInfo().catch(() => null) : null);
    if (info) {
      return formatBuildInfo({
        version: base.version || info.version,
        build: info.build,
        target,
        appId: info.id,
        commit: base.commit,
        channel: base.channel,
      });
    }
  }

  if (platform === "tauri" && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      // Lazy: @tauri-apps/api must never enter the web bundle's main chunk.
      const { getVersion, getIdentifier } = await import("@tauri-apps/api/app");
      const [version, appId] = await Promise.all([getVersion(), getIdentifier()]);
      return formatBuildInfo({
        version: base.version || version,
        build: base.build,
        target,
        appId,
        commit: base.commit,
        channel: base.channel,
      });
    } catch {
      // Fall through to the injected baseline.
    }
  }

  return formatBuildInfo({ version: base.version, build: base.build, target, commit: base.commit, channel: base.channel });
}
