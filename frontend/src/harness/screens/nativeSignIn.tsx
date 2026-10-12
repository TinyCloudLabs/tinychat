// Exo's own native sign-in screen (TC-941), in the pane App gives it on iOS and Android.
import { NativeSignIn } from "@/shell/NativeSignIn";
import type { HarnessScreen } from "../screen";

const pane = (props: Partial<Parameters<typeof NativeSignIn>[0]>) => (
  <div className="h-dvh bg-background text-foreground">
    <main className="h-full overflow-y-auto pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      <NativeSignIn state="unauthenticated" error={null} onSignIn={() => {}} {...props} />
    </main>
  </div>
);

export const nativeSignInScreens: HarnessScreen[] = [
  {
    id: "native-sign-in",
    group: "nativeSignIn",
    layout: "pane",
    platform: "ios",
    displayTitle: true,
    readyWhen: "[data-testid='native-sign-in']",
    render: () => pane({}),
  },
  {
    id: "native-sign-in-busy",
    group: "nativeSignIn",
    layout: "pane",
    platform: "ios",
    displayTitle: true,
    readyWhen: "[data-testid='native-sign-in']",
    render: () => pane({ state: "connecting" }),
  },
  {
    id: "native-sign-in-error",
    group: "nativeSignIn",
    layout: "pane",
    platform: "android",
    displayTitle: true,
    readyWhen: "[data-testid='native-sign-in']",
    render: () => pane({ state: "recoverableError", error: "Couldn't sign in. Please try again." }),
  },
  {
    id: "native-sign-in-from-local-home",
    group: "nativeSignIn",
    layout: "pane",
    platform: "android",
    displayTitle: true,
    readyWhen: "[data-testid='native-sign-in']",
    render: () => pane({ onClose: () => {} }),
  },
];
