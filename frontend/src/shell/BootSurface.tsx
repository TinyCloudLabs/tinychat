import { Button } from "@/components/ui/button";
import type { AppState } from "../lib/appState";

export function BootSurface(props: {
  state: AppState;
  error: string | null;
  /** Sign in, or — in the `offline` state — retry the session restore. */
  onAction: () => void;
  /** The offline voice recorder (TC-515), under the action. */
  voiceNotes?: React.ReactNode;
}) {
  const message =
    props.state === "booting"
      ? "Restoring your session…"
      : props.state === "connecting"
        ? "Finish the OpenKey prompt to continue."
        : props.state === "signing"
          ? "Creating your TinyCloud session…"
          : props.state === "recoverableError"
            ? (props.error ?? "Something went wrong.")
            : props.state === "offline"
              ? (props.error ?? "You're offline.")
              : "Sign in to start chatting. Your conversations live in your TinyCloud space.";

  const busy = props.state === "booting" || props.state === "connecting" || props.state === "signing";

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground">
          T
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-title-2">TinyCloud Chat</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        {(props.state === "unauthenticated" || props.state === "recoverableError" || props.state === "offline") && (
          <Button onClick={props.onAction} className="h-11 px-6 md:h-9 md:px-4">
            {props.state === "unauthenticated" ? "Sign in" : "Try again"}
          </Button>
        )}
        {busy && (
          <span className="text-xs text-muted-foreground">Working…</span>
        )}
        {props.voiceNotes}
      </div>
    </div>
  );
}
