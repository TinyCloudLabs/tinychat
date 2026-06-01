import { type FC } from "react";
import {
  ThreadListItemPrimitive,
  ThreadListPrimitive,
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
        <ThreadListPrimitive.Items components={{ ThreadListItem }} />
      </ThreadListPrimitive.Root>
    </div>
  </TooltipProvider>
);
