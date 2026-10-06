// App's signed-in shell for the browser harnesses (TC-761): the real AppShell
// with the real surfaces, wired the way App.tsx wires them, over stand-ins for
// the session. Chat runs the real ChatWorkspace on the in-memory runtime shim;
// Capture, Connectors and Settings run on the empty-space stub. A state other
// than `ready` shows App's other branch: the sign-in surface, with the offline
// recorder when the session is held offline.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { OFFERED_CHAT_MODELS } from "@tinyboilerplate/core";

import { CaptureSurface } from "@/capture/CaptureSurface";
import { ChatWorkspace } from "@/chat/ChatWorkspace";
import { DEFAULT_CONTEXT_TOKENS } from "@/chat/compaction";
import { ConnectorsPage } from "@/chat/ConnectorsPage";
import { MeetingsSection } from "@/chat/MeetingsSection";
import { ModelPicker, type ModelOption } from "@/chat/ModelPicker";
import type { ModelSelectionController, SelectionView } from "@/chat/modelSelection";
import { OfflineVoiceNotes } from "@/chat/OfflineVoiceNotes";
import { QuickVoiceNote } from "@/chat/QuickVoiceNote";
import { SettingsPage } from "@/chat/SettingsPage";
import { AboutPage } from "@/chat/AboutPage";
import { AgentAccessProvider } from "@/chat/useAgentEnablement";
import { TranscriberLibrarySyncProvider } from "@/chat/useTranscriberLibrarySync";
import type { AppState } from "@/lib/appState";
import type { AppPlatform } from "@/lib/platform";
import { useSizeClass } from "@/lib/sizeClass";
import { useVisualViewportFit } from "@/lib/useVisualViewport";
import { nativeVoiceNotesAvailable } from "@/lib/voiceNotes/nativeVoiceNotes";
import { AppShell } from "@/shell/AppShell";
import { BootSurface } from "@/shell/BootSurface";
import { PATHS, homePath, legacyRedirectFor, screenFor } from "@/shell/routes";
import type { createRuntimeShim } from "./runtimeShim";
import { HARNESS_ADDRESS, HARNESS_DID, harnessSessionStore, harnessTcw } from "./stubs";

const EMPTY_VIEW: SelectionView = {
  threadId: null,
  phase: "choosing",
  model: null,
  revision: 0,
  saving: false,
  saveFailed: false,
  canSend: false,
  canPick: false,
};

const MODELS: ModelOption[] = OFFERED_CHAT_MODELS.map(({ id, contextTokens }, index) => ({
  id,
  contextLength: contextTokens,
  multiplier: [1, 1.5, 0.5, 2][index % 4],
}));

const contextTokensFor = (model: string) =>
  OFFERED_CHAT_MODELS.find((entry) => entry.id === model)?.contextTokens ?? DEFAULT_CONTEXT_TOKENS;

export interface ShellAppProps {
  platform: AppPlatform;
  shim: ReturnType<typeof createRuntimeShim>;
  state: AppState;
  /** Wraps each surface (the shell invariants count mounts with it). */
  probe?: (id: string, node: ReactNode) => ReactNode;
}

export function ShellApp({ platform, shim, state, probe = (_id, node) => node }: ShellAppProps) {
  useVisualViewportFit();
  const location = useLocation();
  const navigate = useNavigate();
  const screen = useMemo(() => screenFor(location.pathname), [location.pathname]);
  const { size } = useSizeClass();
  const [selectionView, setSelectionView] = useState<SelectionView>(EMPTY_VIEW);
  const selectionControllerRef = useRef<ModelSelectionController | null>(null);
  const memoryRef = useRef<string | null>(null);
  const backendUrl = window.location.origin;

  // As App: the chat screen's voice note bar, on Chat only, in the phone app.
  const voiceNotesInApp = useMemo(() => nativeVoiceNotesAvailable(), []);
  const [voiceNoteOpen, setVoiceNoteOpen] = useState<false | "record" | "show">(false);
  const quickVoiceNoteAvailable = voiceNotesInApp && state === "ready" && screen.destination === "chat";
  useEffect(() => {
    if (!quickVoiceNoteAvailable) setVoiceNoteOpen(false);
  }, [quickVoiceNoteAvailable]);

  // As App: a retired address forwards once sign-in has settled (here: ready,
  // or signed out).
  const legacy = legacyRedirectFor(location.pathname);
  const settled = state === "ready" || state === "unauthenticated" || state === "recoverableError";
  useEffect(() => {
    if (!legacy || !settled) return;
    navigate(state === "ready" ? legacy.to : homePath(platform), { replace: true });
  }, [legacy, settled, state, platform, navigate]);

  return (
    <div className="flex flex-col bg-background text-foreground" style={{ height: "var(--tc-app-height, 100dvh)" }}>
      <div className="min-h-0 flex-1">
        {state === "ready" ? (
          <AgentAccessProvider
            tcw={harnessTcw}
            sessionStore={harnessSessionStore}
            backendUrl={backendUrl}
            appName="harness"
            openkeyHost={backendUrl}
          >
            <TranscriberLibrarySyncProvider enabled={false} tcw={harnessTcw} backendUrl={backendUrl} sessionStore={harnessSessionStore}>
              <AppShell
                screen={screen}
                platform={platform}
                pendingMeetings={0}
                chat={probe(
                  "chat",
                  <ChatWorkspace
                    tcw={shim.tcw}
                    sessionStore={shim.sessionStore}
                    backendUrl={backendUrl}
                    selectionControllerRef={selectionControllerRef}
                    selectionView={selectionView}
                    memoryRef={memoryRef}
                    onSelectionView={setSelectionView}
                    onSelectionAuthFailure={() => {}}
                    onMemoryUpdated={() => {}}
                    contextTokensFor={contextTokensFor}
                    composerToolbar={
                      <ModelPicker
                        model={selectionView.model}
                        models={MODELS}
                        disabled={!selectionView.canPick}
                        status={selectionView.message}
                        onPick={(id) => selectionControllerRef.current?.pick(id)}
                        presentation={size === "compact" ? "sheet" : "popover"}
                      />
                    }
                    voiceNoteBar={voiceNoteOpen && quickVoiceNoteAvailable && (
                      <QuickVoiceNote
                        autoStart={voiceNoteOpen === "record"}
                        tcw={harnessTcw}
                        backendUrl={backendUrl}
                        sessionStore={harnessSessionStore}
                        onClose={() => setVoiceNoteOpen(false)}
                        onOpenLibrary={() => navigate(PATHS.library)}
                      />
                    )}
                    onVoiceNote={quickVoiceNoteAvailable ? () => setVoiceNoteOpen((open) => open || "record") : undefined}
                    voiceNoteOpen={voiceNoteOpen !== false}
                    settings
                    billingStatus={null}
                  />,
                )}
                capture={probe(
                  "capture",
                  <CaptureSurface
                    tcw={harnessTcw}
                    backendUrl={backendUrl}
                    sessionStore={harnessSessionStore}
                    active={screen.destination === "capture"}
                    screen={screen}
                    meetingsSlot={<MeetingsSection backendUrl={backendUrl} sessionStore={harnessSessionStore} />}
                  />,
                )}
                connectors={probe(
                  "connectors",
                  <ConnectorsPage tcw={harnessTcw} backendUrl={backendUrl} sessionStore={harnessSessionStore} />,
                )}
                settings={probe(
                  "settings",
                  <SettingsPage
                    address={HARNESS_ADDRESS}
                    did={HARNESS_DID}
                    spaceId="harness-space"
                    state="ready"
                    error={null}
                    onSignOut={() => {}}
                    signingOut={false}
                    paywallEnabled={false}
                    onBack={() => navigate(-1)}
                    tcw={harnessTcw}
                    memoryRef={memoryRef}
                    onMemoryUpdated={() => {}}
                    onImported={() => {}}
                    billingStatus={null}
                    billingTierName={null}
                    onManagePlan={() => {}}
                    onOpenRates={() => {}}
                    backendUrl={backendUrl}
                    sessionStore={harnessSessionStore}
                  />,
                )}
                about={probe("about", <AboutPage onBack={() => navigate(-1)} />)}
              />
            </TranscriberLibrarySyncProvider>
          </AgentAccessProvider>
        ) : (
          <main className="h-full pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
            <BootSurface
              state={state}
              error={null}
              onAction={() => {}}
              voiceNotes={state === "offline" && voiceNotesInApp ? <OfflineVoiceNotes onRecordingChange={() => {}} /> : null}
            />
          </main>
        )}
      </div>
    </div>
  );
}
