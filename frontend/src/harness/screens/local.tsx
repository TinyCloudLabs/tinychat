import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { DeviceCaptureSurface } from "@/capture/DeviceCaptureSurface";
import { screenFor } from "@/shell/routes";
import type { HarnessScreen } from "../screen";

export const localScreens: HarnessScreen[] = [
  {
    id: "local-signed-out",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='capture-surface']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><DeviceCaptureSurface did={null} offline={false} error={null} onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} /></StaticRecorderProvider>
    </div>,
  },
  {
    id: "local-offline",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='capture-surface']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><DeviceCaptureSurface did={null} offline error={null} onSignIn={() => {}} onRetry={() => {}} screen={screenFor("/chat/capture")} /></StaticRecorderProvider>
    </div>,
  },
];
