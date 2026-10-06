import { useCallback, useMemo, useState, type ReactNode } from "react";
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
import { useSizeClass } from "@/lib/sizeClass";
import { createConnectorMeetingsClient } from "../lib/connectors/meetingsApi";
import { createBrowserMeetingTurnRetriever } from "../lib/meetingChat/retriever";
import { createMeetingMessageRegistry } from "./pendingHandoff";
import type { ModelSelectionController, SelectionView } from "./modelSelection";
import { ChatHeader } from "./ChatHeader";
import { ChatsPaneHeader, ChatsSheet } from "./ChatsSheet";
import { ModelVerificationIndicator } from "./ModelVerificationIndicator";
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
  /** The composer's toolbar: the model chip and the usage chip (App owns both). */
  composerToolbar?: ReactNode;
  /** The phone app's voice note bar, under the header while it is open. */
  voiceNoteBar?: ReactNode;
  /** The header's voice note button (phone app only); absent hides it. */
  onVoiceNote?: () => void;
  voiceNoteOpen?: boolean;
  /** Settings is reachable from the Chats sheet (it is not in local validation). */
  settings: boolean;
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
  // The Chats sheet (phones and tablets). A remount (an import's refresh)
  // starts it closed, and it closes itself once the Chats column shows.
  const [chatsOpen, setChatsOpen] = useState(false);
  const openChats = useCallback(() => setChatsOpen(true), []);
  const { size } = useSizeClass();
  const wide = size !== "compact";
  const model = props.selectionView.model;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-1 expanded:grid-cols-[272px_minmax(0,1fr)]">
        {/* The Chats column, always on screen from the expanded class. */}
        <aside className="hidden min-h-0 flex-col border-r border-border/70 expanded:flex">
          <ChatsPaneHeader title={<h2 className="font-display text-title-2">Chats</h2>} placement="column" />
          <ThreadList />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col">
          <ChatHeader
            onOpenChats={size === "expanded" ? undefined : openChats}
            onVoiceNote={props.onVoiceNote}
            voiceNoteOpen={props.voiceNoteOpen}
            newChat={size !== "expanded"}
            verification={wide && model ? <ModelVerificationIndicator model={model} /> : undefined}
          />
          {props.voiceNoteBar}
          <div className="min-h-0 flex-1">
            <Thread
              tcw={props.tcw}
              selection={props.selectionView}
              onRetrySelection={() => props.selectionControllerRef.current?.retry()}
              onReload={() => props.selectionControllerRef.current?.reload()}
              canvasEnabled={conversationCanvas.enabled}
              composerToolbar={props.composerToolbar}
            />
          </div>
        </section>
      </div>
      <ChatsSheet open={chatsOpen} onOpenChange={setChatsOpen} settings={props.settings} />
      {/* C3: first-time enablement + expired-delegation reconnect affordance —
          chat views only (isChatViewPath). */}
      <ChatViewAgentEnablementBanner />
    </AssistantRuntimeProvider>
  );
}
