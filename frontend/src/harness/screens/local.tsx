import { StaticRecorderProvider } from "@/capture/recorder/RecorderProvider";
import { LocalCaptureHome } from "@/capture/local/LocalCaptureHome";
import type { HarnessScreen } from "../screen";

export const localScreens: HarnessScreen[] = [
  {
    id: "local-signed-out",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='local-capture-home']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><LocalCaptureHome onSignIn={() => {}} /></StaticRecorderProvider>
    </div>,
  },
  {
    id: "local-offline",
    group: "local",
    layout: "pane",
    platform: "android",
    readyWhen: "[data-testid='local-capture-home']",
    render: () => <div className="h-dvh overflow-y-auto bg-background">
      <StaticRecorderProvider value={{ signedIn: false }}><LocalCaptureHome offline onRetry={() => {}} /></StaticRecorderProvider>
    </div>,
  },
];
