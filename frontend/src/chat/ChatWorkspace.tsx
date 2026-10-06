import { useCallback, useMemo } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { useChatRuntime } from "./runtime";
import { Thread } from "./Thread";
import { ThreadList } from "./ThreadList";
import { useAgentAccess } from "./useAgentEnablement";
import { ChatViewAgentEnablementBanner } from "./AgentEnablementBanner";
import { appendCompaction, getLatestCompaction } from "../lib/threadStore";
import { completeChat, emitReceipt, type ChatMessage } from "../lib/chatApi";
import { COMPACTION_SUMMARY_MAX_TOKENS } from "./compaction";
import {
  aggregateTurnCredits,
  createBillingClient,
  getCachedRates,
  type BillingStatus,
} from "../lib/billingApi";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { badgePillLabel, connectorsAriaLabel } from "./useBackgroundDrain";
import { createConnectorMeetingsClient } from "../lib/connectors/meetingsApi";
import { createBrowserMeetingTurnRetriever } from "../lib/meetingChat/retriever";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import { PlugIcon } from "lucide-react";
import type { ModelSelectionController, SelectionView } from "./modelSelection";
import { useConversationCanvasFeature } from "./useExperimentalFeatures";
import { promotedCanvasForTurn } from "../lib/conversationCanvasStore";

export function ChatWorkspace(props: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
  selectionControllerRef: React.MutableRefObject<ModelSelectionController | null>;
  selectionView: SelectionView;
  memoryRef: React.MutableRefObject<string | null>;
  onSelectionView: (view: SelectionView) => void;
  onSelectionAuthFailure: () => void;
  onMemoryUpdated: (doc: string | null) => void;
  contextTokensFor: (modelId: string) => number;
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
  showConnectors: boolean;
  pendingMeetings: number;
  onToggleConnectors: () => void;
  onOpenChat: () => void;
  connectorsSurface: React.ReactNode;
  billingStatus: BillingStatus | null;
}) {
  const {
    agentEnabledRef, activeThreadIdRef, privateAccessRef, onDelegationError,
  } = useAgentAccess();
  const meetingMessageRegistry = useMemo(() => createMeetingMessageRegistry(), [props.tcw]);
  const conversationCanvas = useConversationCanvasFeature(props.tcw, props.billingStatus);
  // One instance per mounted workspace: its thread selection state is
  // intentionally in-memory only, survives render churn, and vanishes on a
  // workspace reload. It receives only browser-local handles and the existing
  // session-backed metadata/content client.
  const meetingRetriever = useMemo(
    () => createBrowserMeetingTurnRetriever({
      tcw: props.tcw,
      meetings: createConnectorMeetingsClient(props.backendUrl, {
        sessionStore: props.sessionStore,
      }),
    }),
    [props.tcw, props.sessionStore, props.backendUrl, privateAccessRef.current],
  );

  const deps = useMemo(
    () => ({
      tcw: props.tcw,
      sessionStore: props.sessionStore,
      backendUrl: props.backendUrl,
      selectionControllerRef: props.selectionControllerRef,
      onSelectionView: props.onSelectionView,
      onSelectionAuthFailure: props.onSelectionAuthFailure,
      memoryRef: props.memoryRef,
      onMemoryUpdated: props.onMemoryUpdated,
      activeThreadIdRef,
      agentEnabledRef,
      privateAccessRef,
      onAgentDelegationError: onDelegationError,
      meetingRetriever,
      meetingMessageRegistry,
      // ── Compaction deps (§D.3) ─────────────────────────────────────
      contextTokensFor: props.contextTokensFor,
      getPromotedCanvas: (threadId: string) => promotedCanvasForTurn(props.tcw, threadId),
      getCheckpoint: (threadId: string) => getLatestCompaction(props.tcw, threadId),
      appendCompaction: (threadId: string, coversThroughMessageId: string, summary: string) =>
        appendCompaction(props.tcw, threadId, coversThroughMessageId, summary),
      // Plain single-shot summarization (§C.9): bypasses the runtime exchange
      // ring, so it never writes thread storage / memory nor triggers extraction
      // (§F.3). max_tokens is hard-capped by the summary budget.
      summarize: ({ model, messages }: { model: string; messages: ChatMessage[] }) => {
        // Compaction is a real billed background call with NO pending visible
        // reply, so its credits bump the SESSION METER ONLY — never a badge
        // (edge case a). Fold once via aggregateTurnCredits so in-app usage
        // tracks the ledger; a 0-token/aborted summarize contributes 0.
        let folded = false;
        return completeChat({
          backendUrl: props.backendUrl,
          sessionStore: props.sessionStore,
          model,
          messages,
          maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
          onUsage: (usage) => {
            if (folded) return;
            folded = true;
            void getCachedRates(
              createBillingClient(props.backendUrl, props.sessionStore),
            )
              .then((rates) => {
                const m = rates.models.find((r) => r.id === model);
                if (!m) return;
                const { backgroundCredits } = aggregateTurnCredits(0, [
                  {
                    rates: m,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                  },
                ]);
                if (backgroundCredits > 0) {
                  emitReceipt(model, backgroundCredits, model);
                }
              })
              .catch(() => {
                // receipts are UI sugar; a rates failure must never surface
              });
          },
        });
      },
    }),
    [
      props.tcw,
      props.sessionStore,
      props.backendUrl,
      props.selectionControllerRef,
      props.onSelectionView,
      props.onSelectionAuthFailure,
      props.memoryRef,
      props.onMemoryUpdated,
      props.contextTokensFor,
      onDelegationError,
      meetingRetriever,
      meetingMessageRegistry,
      // activeThreadIdRef and agentEnabledRef are stable refs — omitted intentionally.
    ],
  );

  const runtime = useChatRuntime(deps);
  const closeSidebar = useCallback(
    () => props.setSidebarOpen(false),
    [props.setSidebarOpen],
  );
  const handleChatNavigate = useCallback(() => {
    closeSidebar();
    if (props.showConnectors) props.onOpenChat();
  }, [closeSidebar, props.showConnectors, props.onOpenChat]);
  const handleConnectorsNavigate = useCallback(() => {
    closeSidebar();
    props.onToggleConnectors();
  }, [closeSidebar, props.onToggleConnectors]);
  const { showConnectors, pendingMeetings } = props;
  const connectorsNavigation = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={connectorsAriaLabel(showConnectors, pendingMeetings)}
      aria-pressed={showConnectors}
      onClick={handleConnectorsNavigate}
      className={`relative min-h-11 w-full justify-start gap-2 px-3 py-2 text-sm font-medium md:min-h-0 ${
        showConnectors ? "bg-accent text-accent-foreground" : ""
      }`}
    >
      <PlugIcon className="size-4" />
      Connectors
      {pendingMeetings > 0 && (
        <span
          aria-hidden="true"
          className="absolute right-3 top-1/2 flex h-4 min-w-4 -translate-y-1/2 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground"
        >
          {badgePillLabel(pendingMeetings)}
        </span>
      )}
    </Button>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-1 md:grid-cols-[260px_1fr]">
        <aside className="hidden min-h-0 border-r border-border bg-muted/40 md:block">
          <ThreadList
            navigation={connectorsNavigation}
            onNavigate={handleChatNavigate}
          />
        </aside>
        <section className="min-h-0">
          <div className={showConnectors ? "hidden" : "h-full"}>
            <Thread
              tcw={props.tcw}
              selection={props.selectionView}
              onRetrySelection={() => props.selectionControllerRef.current?.retry()}
              onReload={() => props.selectionControllerRef.current?.reload()}
              canvasEnabled={conversationCanvas.enabled}
            />
          </div>
          {showConnectors && props.connectorsSurface}
        </section>
      </div>
      <Sheet open={props.sidebarOpen} onOpenChange={props.setSidebarOpen}>
        <SheetContent className="md:hidden">
          <SheetTitle className="sr-only">Chats</SheetTitle>
          <SheetDescription className="sr-only">
            List of your saved chats
          </SheetDescription>
          <ThreadList
            navigation={connectorsNavigation}
            onNavigate={handleChatNavigate}
          />
        </SheetContent>
      </Sheet>
      {/* C3: first-time enablement + expired-delegation reconnect affordance —
          chat views only (isChatViewPath). */}
      <ChatViewAgentEnablementBanner />
    </AssistantRuntimeProvider>
  );
}
