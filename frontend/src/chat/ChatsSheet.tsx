// The saved chats as a sheet from the leading edge (TC-761), on phones and
// tablets, where the Chats column is not on screen. Its scrim and panel both
// carry `expanded:hidden`, so neither can linger once the column shows, and it
// closes itself when the window grows into the expanded class (the guard that
// used to live in App). On a phone held upright its foot links to Settings.
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { SettingsIcon } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useSizeClass } from "@/lib/sizeClass";
import { useNavKind } from "@/shell/navItems";
import { PATHS } from "@/shell/routes";
import { NewChatButton, ThreadList } from "./ThreadList";

export function ChatsSheet({
  open,
  onOpenChange,
  settings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Settings is reachable (null in local validation). */
  settings: boolean;
}) {
  const { size } = useSizeClass();
  const nav = useNavKind();
  useEffect(() => {
    if (size === "expanded" && open) onOpenChange(false);
  }, [size, open, onOpenChange]);
  const close = () => onOpenChange(false);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="flex flex-col focus-visible:ring-0 expanded:hidden"
        overlayClassName="expanded:hidden"
        // Focus the sheet itself, not its first button (New chat): the list is
        // what the user came for, and Tab moves into it.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <ChatsPaneHeader placement="sheet" onNavigate={close} title={<SheetTitle className="font-display text-title-2">Chats</SheetTitle>} />
        <SheetDescription className="sr-only">Your saved chats</SheetDescription>
        <ThreadList onNavigate={close} />
        {settings && nav === "tabbar" && (
          <div className="border-t border-border/70 px-2 py-2">
            <Link
              to={PATHS.settings}
              onClick={close}
              className="tap-transparent flex min-h-11 items-center gap-3 rounded-md px-3 text-callout font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground active:bg-surface-2"
            >
              <SettingsIcon aria-hidden className="size-5" />
              Settings
            </Link>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * "Chats" and New chat, above the list. In the column it lines up with the
 * chat header beside it (52 px and the same hairline); in the sheet it leaves
 * room for the sheet's close button.
 */
export function ChatsPaneHeader({
  title,
  onNavigate,
  placement = "column",
}: {
  title: React.ReactNode;
  onNavigate?: () => void;
  placement?: "column" | "sheet";
}) {
  return (
    <div
      className={
        placement === "sheet"
          ? "flex h-14 shrink-0 items-center gap-1 pl-4 pr-14"
          : "mb-2 flex h-13 shrink-0 items-center gap-1 border-b border-border/70 pl-4 pr-2"
      }
    >
      <div className="min-w-0 flex-1 truncate">{title}</div>
      <NewChatButton onNavigate={onNavigate} />
    </div>
  );
}
