import { type FC } from "react";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { TooltipProvider } from "@/components/ui/tooltip";

const ThreadListItem: FC = () => (
  <ThreadListItemPrimitive.Root className="group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-accent data-[active]:bg-accent">
    <ThreadListItemPrimitive.Trigger className="flex-1 truncate px-3 py-2 text-left text-sm text-foreground">
      <ThreadListItemPrimitive.Title fallback="New chat" />
    </ThreadListItemPrimitive.Trigger>
    <ThreadListItemPrimitive.Delete asChild>
      <TooltipIconButton
        tooltip="Delete chat"
        className="size-7 shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 data-[active]:opacity-100"
      >
        <Trash2Icon className="size-4" />
      </TooltipIconButton>
    </ThreadListItemPrimitive.Delete>
  </ThreadListItemPrimitive.Root>
);

export const ThreadList: FC = () => (
  <TooltipProvider delayDuration={300}>
    <div className="flex h-full flex-col gap-2 p-2">
      <ThreadListPrimitive.New className="flex items-center justify-start gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
        <PlusIcon className="size-4" />
        New chat
      </ThreadListPrimitive.New>
      <ThreadListPrimitive.Root className="flex flex-1 flex-col gap-0.5 overflow-y-auto pr-0.5">
        <ThreadListContents />
      </ThreadListPrimitive.Root>
    </div>
  </TooltipProvider>
);

// The sidebar list is read sequentially from KV on sign-in, so it can be empty
// for a moment. Show skeleton rows during the initial load instead of a blank
// gap, and a quiet hint once we know there are genuinely no chats yet.
const ThreadListContents: FC = () => {
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const count = useAuiState((s) => s.threads.threadIds.length);

  if (isLoading && count === 0) return <ThreadListSkeleton />;

  if (!isLoading && count === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No chats yet. Start a new one above.
      </p>
    );
  }

  return <ThreadListPrimitive.Items components={{ ThreadListItem }} />;
};

const ThreadListSkeleton: FC = () => (
  <div className="flex flex-col gap-1" aria-hidden>
    {Array.from({ length: 5 }).map((_, i) => (
      <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/70" />
    ))}
  </div>
);
