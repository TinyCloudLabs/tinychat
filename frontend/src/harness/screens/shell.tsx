// The shell (TC-761): the real AppShell and surfaces, wired as App wires them
// (harness/ShellApp.tsx), at every size class: the tab bar on a phone held
// upright, the rail on its side and on tablets, the sidebar from 1024 px. Most
// screens run as the phone app (its landing, its voice note button and the
// fake recorder); `shell-capture-web` shows Capture as the web and desktop app
// have it. Sheets are opened after mount, the way a tap would.
import { useContext, useEffect, useMemo, useState } from "react";

import type { AppState } from "@/lib/appState";
import { PlatformContext } from "@/lib/platform";
import { createRuntimeShim } from "../runtimeShim";
import type { HarnessScreen } from "../screen";
import { ShellApp } from "../ShellApp";
import type { RecorderValue } from "@/capture/recorder/RecorderProvider";

function Shell(props: { state?: AppState; scenario?: string; act?: () => boolean; recorder?: Partial<RecorderValue> }) {
  const platform = useContext(PlatformContext);
  const shim = useMemo(() => createRuntimeShim({ scenario: props.scenario }), [props.scenario]);
  const [sheetOpen, setSheetOpen] = useState(props.recorder?.sheetOpen ?? false);
  const recorder = props.recorder && {
    ...props.recorder,
    sheetOpen,
    minimiseSheet: () => setSheetOpen(false),
  };
  return (
    <>
      <ShellApp platform={platform} shim={shim} state={props.state ?? "ready"} recorder={recorder} />
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

const openChatTab = () => {
  const modelButton = document.querySelector<HTMLButtonElement>('button[aria-label="Model"]:not([disabled])');
  if (modelButton?.getClientRects().length) {
    document.documentElement.dataset.harnessChatOpenedFromCapture = "true";
    return true;
  }
  if (document.documentElement.dataset.harnessChatTabClicked === "true") return false;
  const tab = document.querySelector<HTMLAnchorElement>('a[href="/chat"]');
  if (!tab) return false;
  tab.click();
  document.documentElement.dataset.harnessChatTabClicked = "true";
  return false;
};

const minimiseRecorder = () => {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Minimise recorder"]');
  if (!button) return false;
  button.click();
  return true;
};

function newChatAfterOpeningSavedThread() {
  let selectedSavedThread = false;
  let startedNewChat = false;
  return () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]');
    const oldQuestion = [...document.querySelectorAll<HTMLParagraphElement>("p")].find(
      (paragraph) => paragraph.textContent?.trim() === "old question" && paragraph.getClientRects().length > 0,
    );
    if (startedNewChat) {
      const modelButton = document.querySelector<HTMLButtonElement>('button[aria-label="Model"]:not([disabled])');
      if (dialog || oldQuestion || !modelButton?.getClientRects().length) return false;
      document.documentElement.dataset.harnessNewChatFromSaved = "true";
      return true;
    }

    if (dialog) {
      if (!selectedSavedThread) {
        const savedThread = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent?.trim() === "Saved",
        );
        if (savedThread) {
          savedThread.click();
          selectedSavedThread = true;
        }
      }
      return false;
    }

    if (oldQuestion && document.documentElement.hasAttribute("data-island")) {
      const newChat = document.querySelector<HTMLButtonElement>('button[aria-label="New chat"]');
      if (!newChat) return false;
      newChat.click();
      startedNewChat = true;
      return false;
    }

    if (!selectedSavedThread) {
      document.querySelector<HTMLButtonElement>('button[aria-label="Chats"]')?.click();
    }
    return false;
  };
}

const SHELL = { group: "shell", layout: "pane", displayTitle: true } as const;
const RIBBON_RECORDING: Partial<RecorderValue> = {
  available: true,
  ready: true,
  phase: "recording",
  mic: { state: "recording", reason: null },
  startedAt: Date.now() - 12 * 60_000,
  audioMs: 12 * 60_000,
  elapsedMs: 12 * 60_000,
  sheetOpen: false,
};

export const shellScreens: HarnessScreen[] = [
  {
    ...SHELL,
    displayTitle: false,
    id: "shell-capture",
    path: "/chat/capture",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    displayTitle: false,
    id: "shell-capture-web",
    path: "/chat/capture",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    displayTitle: false,
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
    id: "shell-settings-agent-access",
    path: "/chat/settings#agent-access",
    platform: "ios",
    readyWhen: "#agent-access",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-chat-ribbon",
    path: "/chat",
    platform: "ios",
    readyWhen: 'button[aria-label="Model"]:not([disabled])',
    render: () => <Shell recorder={{
      phase: "recording",
      mic: { state: "recording", reason: null },
      startedAt: Date.now() - 83_000,
      elapsedMs: 83_000,
      recordingId: "harness-minimized-recording",
      sheetOpen: false,
    }} />,
  },
  {
    ...SHELL,
    id: "shell-chat-ribbon-from-capture",
    path: "/chat/capture",
    readyWhen: 'html[data-harness-chat-opened-from-capture="true"]',
    render: () => <Shell act={openChatTab} recorder={{
      phase: "recording",
      mic: { state: "recording", reason: null },
      startedAt: Date.now() - 83_000,
      elapsedMs: 83_000,
      recordingId: "harness-minimized-recording",
      sheetOpen: false,
    }} />,
  },
  {
    ...SHELL,
    id: "shell-chat-ribbon-minimized-from-chat",
    path: "/chat",
    platform: "ios",
    readyWhen: 'button[aria-label="Model"]:not([disabled])',
    render: () => <Shell act={minimiseRecorder} recorder={{
      phase: "recording",
      mic: { state: "recording", reason: null },
      startedAt: Date.now() - 83_000,
      elapsedMs: 83_000,
      recordingId: "harness-minimized-recording",
      sheetOpen: true,
    }} />,
  },
  {
    ...SHELL,
    id: "shell-chat-new-ribbon",
    path: "/chat",
    platform: "ios",
    readyWhen: 'html[data-harness-new-chat-from-saved="true"]',
    viewports: ["phone", "phone-land", "phone-small", "text200-phone", "text80-phone", "text250-phone", "text330-phone"],
    render: () => <Shell scenario="reopen" act={newChatAfterOpeningSavedThread()} recorder={{
      phase: "recording",
      mic: { state: "recording", reason: null },
      startedAt: Date.now() - 83_000,
      elapsedMs: 83_000,
      recordingId: "harness-minimized-recording",
      sheetOpen: false,
    }} />,
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
    id: "shell-connectors-ribbon",
    path: "/chat/connectors",
    platform: "android",
    render: () => <Shell recorder={RIBBON_RECORDING} />,
  },
  {
    ...SHELL,
    id: "shell-settings",
    path: "/chat/settings",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-settings-android",
    path: "/chat/settings",
    platform: "android",
    render: () => <Shell />,
  },
  // Scrolled: the large title has collapsed into the header row, with its hairline.
  {
    ...SHELL,
    displayTitle: false,
    id: "shell-capture-scrolled",
    path: "/chat/capture",
    platform: "ios",
    scrollTo: '[data-testid="capture-actions"]',
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
  // Settings -> Voice notes (TC-1618) as each platform shows it: the web and desktop app (no native
  // transcriber control) and the phone app (with it).
  ...(["web", "tauri", "ios"] as const).map((platform) => ({
    ...SHELL,
    displayTitle: false,
    id: `shell-settings-voice-notes-${platform}`,
    path: "/chat/settings",
    platform,
    scrollTo: "section:has(> div > svg.lucide-mic)",
    render: () => <Shell />,
  })),
  // How it works, from the top and opened at a section (a HowItWorksLink's anchor).
  {
    ...SHELL,
    id: "shell-about",
    path: "/chat/about",
    platform: "ios",
    render: () => <Shell />,
  },
  {
    ...SHELL,
    id: "shell-about-section",
    path: "/chat/about#connectors",
    platform: "ios",
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
  // The build line (TC-840) at the bottom of Settings — and, from 1024 px, at
  // the sidebar's foot beside it.
  {
    ...SHELL,
    id: "shell-settings-build-info",
    path: "/chat/settings",
    platform: "ios",
    scrollTo: '[data-surface="settings"] [data-testid="build-info"]',
    render: () => <Shell />,
  },
];
