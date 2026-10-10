import type { AppPlatform } from "@/lib/platform";
import type { SizeClass } from "@/lib/sizeClass";
import type { NavKind } from "@/shell/navItems";
import type { CaptureSettingsVariant } from "../../recorder/final/desktop/CaptureSettings";
import {
  shellCapabilities,
  type RecorderLayout,
} from "../../recorder/final/shellCapabilities";

/** Which home Capture draws: the phone's Soft one (TC-871) at a compact width, the desktop's from medium up. */
export type CaptureHomeKind = "phone" | "desktop";

export function captureHomeKind(size: SizeClass): CaptureHomeKind {
  return size === "compact" ? "phone" : "desktop";
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
