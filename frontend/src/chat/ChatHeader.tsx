// The chat screen's header (TC-761), 52 px:
//
//   [Chats]  Weekly recap   [verification] [voice note] [new chat]
//
// Chats opens the list as a sheet where it is not always on screen (phones and
// tablets). The thread's title is the screen's heading. On wide screens the
// model's verification indicator sits here; on phones it is in the model sheet.
// The voice note button exists only in the phone app (QuickVoiceNote, until the
// recorder replaces it in PR4).
import type { ReactNode } from "react";
import { ThreadListPrimitive, useAuiState } from "@assistant-ui/react";
import { MicIcon, PanelLeftIcon, SquarePenIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface ChatHeaderProps {
  /** Opens the Chats sheet; absent where the Chats column is always shown. */
  onOpenChats?: () => void;
  /** The phone app's one-tap voice note; absent hides the button. */
  onVoiceNote?: () => void;
  /** The voice note bar is open. */
  voiceNoteOpen?: boolean;
  /** A New chat button here (the Chats column has its own beside it). */
  newChat: boolean;
  /** The model's verification indicator (wide screens). */
  verification?: ReactNode;
}

const ICON_BUTTON = "size-11 shrink-0 rounded-full text-muted-foreground hover:text-foreground fine:size-9 [&_svg]:size-5";

export function ChatHeader({ onOpenChats, onVoiceNote, voiceNoteOpen = false, newChat, verification }: ChatHeaderProps) {
  const title = useAuiState((s) => s.threadListItem.title);
  return (
    <header className="flex min-h-13 shrink-0 items-center gap-1 py-1 border-b border-border/70 bg-background px-2 medium:px-3 expanded:px-4">
      {onOpenChats && (
        <Button variant="ghost" size="icon" aria-label="Chats" title="Chats" onClick={onOpenChats} className={ICON_BUTTON}>
          <PanelLeftIcon />
        </Button>
      )}
      {/* Two lines at most: a long title (or large text) wraps before it truncates. */}
      <h1 tabIndex={-1} className={cn("line-clamp-2 min-w-0 flex-1 break-words text-headline leading-tight outline-none", onOpenChats ? "px-1" : "px-2")}>
        {title || "New chat"}
      </h1>
      {verification}
      {onVoiceNote && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Record a voice note"
          aria-pressed={voiceNoteOpen}
          onClick={onVoiceNote}
          data-testid="header-voice-note"
          className={cn(ICON_BUTTON, voiceNoteOpen && "bg-selected text-foreground")}
        >
          <MicIcon />
        </Button>
      )}
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
