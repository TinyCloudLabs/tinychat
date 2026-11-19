// The chat screen's header (TC-761), 52 px:
//
//   [Chats]  Weekly recap   [verification] [live recording] [new chat]
//
// Chats opens the list as a sheet where it is not always on screen (phones and
// tablets). The thread's title is the screen's heading. On wide screens the
// model's verification indicator sits here; on phones it is in the model sheet.
// The recorder slot keeps a live recording reachable while the keyboard is up.
import type { ReactNode } from "react";
import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { PanelLeftIcon, SquarePenIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChatHeaderProps {
  /** Opens the Chats sheet; absent where the Chats column is always shown. */
  onOpenChats?: () => void;
  /** The phone app's live-recording chip. */
  recorder?: ReactNode;
  /** A New chat button here (the Chats column has its own beside it). */
  newChat: boolean;
  /** The model's verification indicator (wide screens). */
  verification?: ReactNode;
}

const ICON_BUTTON = "size-[44px] shrink-0 rounded-full text-muted-foreground hover:text-foreground fine:size-9 [&_svg]:size-[20px]";

export function ChatHeader({ onOpenChats, recorder, newChat, verification }: ChatHeaderProps) {
  const title = useAuiState((s) => s.threadListItem.title);
  return (
    <header data-testid="chat-header" className="flex min-h-[52px] shrink-0 flex-wrap items-center gap-1 py-1 border-b border-border/70 bg-background px-2 medium:px-3 expanded:px-4">
      {onOpenChats && (
        <Button variant="ghost" size="icon" aria-label="Chats" title="Chats" onClick={onOpenChats} className={ICON_BUTTON}>
          <PanelLeftIcon />
        </Button>
      )}
      {/* Two lines at most: a long title (or large text) wraps before it truncates. */}
      <h1 tabIndex={-1} className={cn("min-w-[8ch] flex-1 break-words text-headline leading-tight outline-none [overflow-wrap:anywhere]", onOpenChats ? "px-1" : "px-2")}>
        {title || "New chat"}
      </h1>
      {verification}
      {recorder}
      {newChat && (
        <ThreadListPrimitive.New asChild>
          <Button variant="ghost" size="icon" aria-label="New chat" title="New chat" className={ICON_BUTTON}>
            <SquarePenIcon />
          </Button>
        </ThreadListPrimitive.New>
      )}
    </header>
  );
}
