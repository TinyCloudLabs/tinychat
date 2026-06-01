import { type FC } from "react";
import { ThreadListPrimitive, ThreadListItemPrimitive } from "@assistant-ui/react";

const ThreadListItem: FC = () => (
  <ThreadListItemPrimitive.Root className="group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-accent data-[active]:bg-accent">
    <ThreadListItemPrimitive.Trigger className="flex-1 truncate text-left text-foreground">
      <ThreadListItemPrimitive.Title fallback="New chat" />
    </ThreadListItemPrimitive.Trigger>
    <ThreadListItemPrimitive.Delete
      className="shrink-0 rounded px-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
      aria-label="Delete chat"
    >
      ✕
    </ThreadListItemPrimitive.Delete>
  </ThreadListItemPrimitive.Root>
);

export const ThreadList: FC = () => (
  <div className="flex h-full flex-col gap-2 p-2">
    <ThreadListPrimitive.New className="flex items-center justify-center gap-2 rounded-lg border border-input px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent">
      + New chat
    </ThreadListPrimitive.New>
    <ThreadListPrimitive.Root className="flex flex-1 flex-col gap-1 overflow-y-auto">
      <ThreadListPrimitive.Items components={{ ThreadListItem }} />
    </ThreadListPrimitive.Root>
  </div>
);
