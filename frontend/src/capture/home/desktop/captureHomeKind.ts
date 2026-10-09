import type { AppPlatform } from "@/lib/platform";
import type { SizeClass } from "@/lib/sizeClass";
import type { NavKind } from "@/shell/navItems";
import type { CaptureSettingsVariant } from "../../recorder/final/desktop/CaptureSettings";
import {
  shellCapabilities,
  type RecorderLayout,
} from "../../recorder/final/shellCapabilities";

/** Which home Capture draws: today's, the phone's Soft one (TC-871), or the desktop's (flag on, recorder available, a rail or sidebar). */
export type CaptureHomeKind = "classic" | "phone" | "desktop";

export function captureHomeKind(input: {
  flag: boolean;
  /** The recorder can record on this shell; without it the desktop home has nothing to start. */
  available: boolean;
  nav: NavKind;
  size: SizeClass;
}): CaptureHomeKind {
  if (!input.flag) return "classic";
  if (input.nav === "tabbar" && input.size === "compact") return "phone";
  if (input.nav !== "tabbar" && input.size !== "compact" && input.available)
    return "desktop";
  return "classic";
}

export function layoutForNav(nav: NavKind): RecorderLayout {
  return nav === "tabbar" ? "phone" : nav === "rail" ? "rail" : "desktop";
}

export interface DesktopHomeCapabilities {
  /** The ⚙︎ button's variant; null leaves the button out. */
  settings: CaptureSettingsVariant | null;
  /** Connect existing meetings opens the Meeting sources window. */
  connectMeetings: boolean;
  /** The "N voice notes on this Mac" card can show. */
  onThisMac: boolean;
}

export function desktopHomeCapabilities(
  platform: AppPlatform,
  layout: RecorderLayout,
): DesktopHomeCapabilities {
  const caps = shellCapabilities(platform, layout);
  return {
    settings:
      caps.captureSettings === true
        ? "app"
        : caps.captureSettings === "microphone-only"
          ? "microphone-only"
          : null,
    connectMeetings: caps.meetingSources,
    onThisMac: caps.notYetUploadedList,
  };
}
