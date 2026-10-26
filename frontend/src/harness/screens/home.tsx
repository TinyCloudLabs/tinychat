// TinyCloud Home's navigation (TC-2040): the real shell on the web at its new
// destinations. Ids start with `shell-chat-` so the 320 px phone viewport (and
// the text200 rail) capture them with the existing viewport scopes.
import { useContext, useEffect, useMemo } from "react";

import { PlatformContext } from "@/lib/platform";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import { setAppsFeedEnabled } from "@/lib/appsFeedFeature";

function Home() {
  useEffect(() => { setAppsFeedEnabled(true); }, []);
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim({}), []);
  return <ShellApp platform={platform} shim={shim} state="ready" />;
}

const HOME = { group: "home", layout: "pane", displayTitle: true, platform: "web" } as const;

export const homeScreens: HarnessScreen[] = [
  { ...HOME, id: "shell-chat-home-feed", displayTitle: false, path: "/chat/feed", readyWhen: 'a[href="/chat/feed"][aria-current="page"], [data-surface="feed"]', render: () => <Home /> },
  { ...HOME, id: "shell-chat-home-apps", path: "/chat/apps", readyWhen: 'a[href^="https://share.tinycloud.xyz/apps/run"]', render: () => <Home /> },
  { ...HOME, id: "shell-chat-home-chat", path: "/chat", readyWhen: 'a[href="/chat/apps"]', render: () => <Home /> },
];
