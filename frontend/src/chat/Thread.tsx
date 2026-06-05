import { useEffect, useState, type FC } from "react";
import {
  ActionBarPrimitive,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useMessage,
} from "@assistant-ui/react";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  SendHorizontalIcon,
  Square,
} from "lucide-react";

import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  formatCredits,
  getReceipt,
  onReceipt,
  type ReceiptEntry,
} from "@/lib/billingApi";

export const Thread: FC = () => {
  return (
    <TooltipProvider delayDuration={300}>
      <ThreadPrimitive.Root className="flex h-full flex-col bg-background">
        <ThreadPrimitive.Viewport className="relative flex flex-1 flex-col items-center overflow-y-auto scroll-smooth px-4">
          <div className="flex w-full max-w-[46rem] flex-1 flex-col gap-6 pt-8">
            <ThreadBody />
          </div>

          <Composer />
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </TooltipProvider>
  );
};

// Decides what fills the viewport: a loading skeleton while the active thread's
// history is being read from KV, the welcome screen for a fresh chat, or the
// message list once messages exist.
const ThreadBody: FC = () => {
  const isLoading = useAuiState((s) => s.thread.isLoading);
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  const status = useAuiState((s) => s.threadListItem.status);

  // A switched-to existing thread reports `status: "regular"` and `isEmpty`
  // for ~1 frame before its history `load()` flips `isLoading` on. Treat that
  // gap as loading too, so switching chats never flashes the welcome screen.
  // (A persisted thread always has >=1 message, so "regular & empty" only ever
  // means "not loaded yet", never a genuinely empty conversation.)
  //
  // A brand-new chat (`status: "new"`) is exempt: it has no history to load,
  // but the runtime still flips `isLoading` on for its (empty) history fetch —
  // without the exemption the welcome screen hides behind a skeleton for the
  // whole round-trip on every boot.
  const showSkeleton =
    status !== "new" && (isLoading || (isEmpty && status === "regular"));

  if (showSkeleton) return <HistorySkeleton />;

  return (
    <>
      <ThreadWelcome />

      <ThreadPrimitive.Messages
        components={{
          UserMessage,
          AssistantMessage,
        }}
      />

      <ThreadPrimitive.If empty={false}>
        <div className="min-h-6 flex-shrink-0" />
      </ThreadPrimitive.If>
    </>
  );
};

// Shimmer placeholder shaped like a short conversation, shown while a thread's
// history loads or while switching between chats.
const HistorySkeleton: FC = () => (
  <div className="flex w-full flex-col gap-6 py-4" aria-hidden>
    <div className="flex w-full justify-end">
      <div className="h-9 w-2/5 animate-pulse rounded-3xl bg-muted" />
    </div>
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="size-5 animate-pulse rounded-full bg-muted" />
        <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex flex-col gap-2 pl-7">
        <div className="h-3 w-full animate-pulse rounded bg-muted" />
        <div className="h-3 w-11/12 animate-pulse rounded bg-muted" />
        <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
      </div>
    </div>
    <div className="flex w-full justify-end">
      <div className="h-9 w-1/3 animate-pulse rounded-3xl bg-muted" />
    </div>
    <div className="flex flex-col gap-2 pl-7">
      <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
      <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
    </div>
  </div>
);

const ThreadWelcome: FC = () => {
  return (
    <ThreadPrimitive.Empty>
      <div className="flex w-full flex-1 flex-col items-center justify-center gap-6 py-16 text-center">
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">TinyCloud Chat</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Your conversations are private and stored in your TinyCloud space.
          </p>
        </div>
        <div className="grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
          {WELCOME_SUGGESTIONS.map((s) => (
            <ThreadPrimitive.Suggestion
              key={s.text}
              prompt={s.text}
              method="replace"
              autoSend={false}
              className="rounded-xl border border-border bg-card px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-accent"
            >
              <span className="block font-medium">{s.title}</span>
              <span className="block text-xs text-muted-foreground">
                {s.text}
              </span>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </ThreadPrimitive.Empty>
  );
};

const WELCOME_SUGGESTIONS = [
  {
    title: "Explain a concept",
    text: "Explain how public-key cryptography works, simply.",
  },
  {
    title: "Write some code",
    text: "Write a TypeScript function that debounces a callback.",
  },
  {
    title: "Brainstorm",
    text: "Give me five ideas for a weekend side project.",
  },
  {
    title: "Markdown demo",
    text: "Show me a markdown example with a heading, a bullet list, and a code block.",
  },
];

const Composer: FC = () => {
  return (
    <div className="sticky bottom-0 z-10 w-full max-w-[46rem] bg-gradient-to-t from-background via-background to-transparent pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
      <div className="relative">
        <ScrollToBottom />
      </div>
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-input bg-card p-2 shadow-sm transition-shadow focus-within:border-ring focus-within:shadow-md">
        <ComposerPrimitive.Input
          autoFocus
          rows={1}
          placeholder="Message TinyCloud Chat…"
          className="max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground"
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send"
              side="top"
              type="submit"
              className="size-9 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <SendHorizontalIcon className="size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel asChild>
            <TooltipIconButton
              tooltip="Stop"
              side="top"
              className="size-9 rounded-full border border-input text-foreground hover:bg-accent"
            >
              <Square className="size-4 fill-current" />
            </TooltipIconButton>
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </ComposerPrimitive.Root>
    </div>
  );
};

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="flex w-full flex-col items-end gap-1">
    <div className="max-w-[80%] rounded-3xl bg-muted px-5 py-2.5 text-sm leading-relaxed text-foreground">
      <MessagePrimitive.Parts />
    </div>
    <ReceiptFooter />
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="group flex w-full flex-col gap-1">
    <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
      <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
        T
      </span>
      <span>TinyCloud Chat</span>
    </div>
    <div className="pl-7 text-sm leading-relaxed text-foreground">
      <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
    </div>
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="ml-7 mt-1 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
        <ErrorPrimitive.Message className="leading-relaxed" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
    <AssistantActionBar />
  </MessagePrimitive.Root>
);

const AssistantActionBar: FC = () => (
  <div className="flex items-center gap-2 pl-6">
    {/* Always visible (no hover-reveal) — hover felt finicky; hideWhenRunning
        still keeps it out of the way while a reply is streaming. */}
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="flex items-center gap-1"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip="Copy">
          <MessagePrimitive.If copied>
            <CheckIcon />
          </MessagePrimitive.If>
          <MessagePrimitive.If copied={false}>
            <CopyIcon />
          </MessagePrimitive.If>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
    <ReceiptFooter />
  </div>
);

// Always-on per-message receipt (spec §5.3). One exchange registers two
// entries: the input (prompt) share on the user message and the output
// (completion) share on the assistant message; the two always sum to the
// charged total. Renders only when the session receipt store has THIS message
// id — historical messages from before a reload have none (persisting receipts
// is a v2 follow-up). Subscribes to the store so the line appears the moment
// the stream completes without re-mounting the message; a non-interactive,
// screen-reader-safe span that does not shift layout during streaming.
const ReceiptFooter: FC = () => {
  const messageId = useMessage((m) => m.id);
  const [entry, setEntry] = useState<ReceiptEntry | undefined>(() =>
    getReceipt(messageId),
  );
  useEffect(() => {
    // Re-check on mount in case the receipt landed between render + effect.
    setEntry(getReceipt(messageId));
    return onReceipt((id, e) => {
      if (id === messageId) setEntry(e);
    });
  }, [messageId]);
  if (entry === undefined) return null;
  const label =
    entry.side === "input"
      ? "Input cost — includes conversation context"
      : `Cost: ${formatCredits(entry.credits)}`;
  return (
    <span
      className="text-[11px] leading-none text-muted-foreground/70 tabular-nums"
      aria-label={label}
      title={entry.side === "input" ? label : undefined}
    >
      {formatCredits(entry.credits)}
    </span>
  );
};

export const ScrollToBottom: FC = () => (
  <ThreadPrimitive.ScrollToBottom asChild>
    <TooltipIconButton
      tooltip="Scroll to bottom"
      className="absolute -top-10 left-1/2 z-10 size-8 -translate-x-1/2 rounded-full border border-border bg-background shadow-sm disabled:invisible"
    >
      <ArrowDownIcon />
    </TooltipIconButton>
  </ThreadPrimitive.ScrollToBottom>
);
