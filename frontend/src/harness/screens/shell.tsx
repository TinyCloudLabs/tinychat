// The shell (TC-761): the real AppShell and surfaces, wired as App wires them
// (harness/ShellApp.tsx), at every size class: the tab bar on a phone held
// upright, the rail on its side and on tablets, the sidebar from 1024 px. Most
// screens run as the phone app (its landing, its voice note button and the
// fake recorder); `shell-capture-web` shows Capture as the web and desktop app
// have it. Sheets are opened after mount, the way a tap would.
import { useContext, useEffect, useMemo } from "react";

import type { AppState } from "@/lib/appState";
import { PlatformContext } from "@/lib/platform";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";

function Shell(props: { state?: AppState; act?: () => boolean }) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim(), []);
  return (
    <>
      <ShellApp platform={platform} shim={shim} state={props.state ?? "ready"} />
      {props.act && <Act run={props.act} />}
    </>
  );
}

/** Runs `run` every 100 ms until it reports done (a control can be disabled until data loads). */
function Act({ run }: { run: () => boolean }) {
  useEffect(() => {
    let timer = 0;
    const attempt = (left: number) => {
      if (run() === true || left <= 0) return;
      timer = window.setTimeout(() => attempt(left - 1), 100);
    };
    timer = window.setTimeout(() => attempt(40), 50);
    return () => window.clearTimeout(timer);
  }, [run]);
  return null;
}

const openModelPicker = () => {
  if (document.querySelector("#model-picker-popup")) return true;
  const chip = document.querySelector<HTMLButtonElement>('button[aria-label="Model"]:not([disabled])');
  chip?.click();
  return false;
};

const openChats = () => {
  if (document.querySelector('[role="dialog"][data-state="open"]')) return true;
  // From 1024 px the Chats column is always on screen, and there is no button.
  if (document.documentElement.dataset.size === "expanded") return true;
  document.querySelector<HTMLButtonElement>('button[aria-label="Chats"]')?.click();
  return false;
};

const typeWithKeyboard = () => {
  const composer = document.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Message"]');
  if (!composer || composer.disabled) return false;
  composer.focus();
  // A browser has no on-screen keyboard to raise: mark it up, as useKeyboardOpen does on a phone.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      document.documentElement.dataset.keyboard = "open";
    }),
  );
  return true;
};

const SHELL = { group: "shell", layout: "pane", displayTitle: true } as const;

export const shellScreens: HarnessScreen[] = [
  {
    ...SHELL,
    id: "shell-capture",
    path: "/chat/capture",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-capture-web",
    path: "/chat/capture",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-library",
    path: "/chat/capture/library",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-chat",
    path: "/chat",
    platform: "ios",
    readyWhen: 'button[aria-label="Model"]:not([disabled])',
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-chat-keyboard",
    path: "/chat",
    platform: "ios",
    readyWhen: 'html[data-keyboard="open"]',
    render: () => <Shell act={typeWithKeyboard} />,
  },
  {
    ...SHELL,
    id: "shell-model-sheet",
    path: "/chat",
    platform: "ios",
    readyWhen: "#model-picker-popup",
    render: () => <Shell act={openModelPicker} />,
  },
  {
    ...SHELL,
    id: "shell-chats-sheet",
    path: "/chat",
    platform: "ios",
    readyWhen: '[role="dialog"][data-state="open"], html[data-size="expanded"]',
    render: () => <Shell act={openChats} />,
  },
  {
    ...SHELL,
    id: "shell-connectors",
    path: "/chat/connectors",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-settings",
    path: "/chat/settings",
    platform: "ios",
    render: () => <Shell />,
  },
  // Scrolled: the large title has collapsed into the header row, with its hairline.
  {
    ...SHELL,
    id: "shell-capture-scrolled",
    path: "/chat/capture",
    platform: "ios",
    scrollTo: 'button[aria-label="Refresh transcriber meetings"]',
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-settings-scrolled",
    path: "/chat/settings",
    platform: "ios",
    scrollTo: "section:has(> div > svg.lucide-sun)",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-boot-signed-out",
    path: "/chat/capture",
    platform: "ios",
    render: () => <Shell state="unauthenticated" />,
  },
  {
    ...SHELL,
    id: "shell-boot-offline",
    path: "/chat/capture",
    platform: "ios",
    render: () => <Shell state="offline" />,
  },
];
