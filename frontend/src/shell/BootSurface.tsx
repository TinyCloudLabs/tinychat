import { BuildInfoLine } from "@/components/BuildInfoLine";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import type { AppState } from "../lib/appState";
import { errorLinkFor } from "../lib/authErrors";
import { LANDING_LINK_LABEL } from "../lib/homeStrings";

/** The line under the title for each state; the native sign-in screen shows the same busy and error copy. */
export function bootMessage(state: AppState, error: string | null): string {
  return state === "booting"
    ? "Restoring your session…"
    : state === "connecting"
      ? "Finish the OpenKey prompt to continue."
      : state === "signing"
        ? "Creating your TinyCloud session…"
        : state === "recoverableError"
          ? (error ?? "Something went wrong.")
          : state === "offline"
            ? (error ?? "You're offline.")
            : (error ?? "Sign in to continue.");
}

export function BootSurface(props: {
  state: AppState;
  error: string | null;
  /** Sign in, or — in the `offline` state — retry the session restore. */
  onAction: () => void;
  approvalAction?: () => void;
  approvalReady?: boolean;
  /** The offline voice recorder (TC-515), under the action. */
  voiceNotes?: React.ReactNode;
  /** TinyCloud Home on the web (TC-2040): a plain link to the landing page at /about. */
  home?: boolean;
}) {
  const message = bootMessage(props.state, props.error);

  const errorLink = props.state === "unauthenticated" || props.state === "recoverableError" ? errorLinkFor(props.error) : null;
  const busy = props.state === "booting" || props.state === "connecting" || (props.state === "signing" && !props.approvalReady);

  return (
    // Content centred while it fits; scrolls (from the top) when it does not,
    // as with the offline recorder on a phone on its side. The empty first row
    // and the build line's row share the free space evenly, so the content
    // stays centred and the line stays pinned to the foot (TC-840).
    <div className="grid h-full grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] overflow-y-auto p-6">
      <div aria-hidden />
      <div className="mx-auto flex w-full min-w-0 max-w-sm flex-col items-center gap-5 text-center">
        <img src="/icons/pwa-192.png" alt="" className="size-12 rounded-2xl" />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-display text-title-2">Exo</h1>
          <p className="flex items-center justify-center text-callout text-muted-foreground">
            {props.approvalReady ? "Approve your sign-in in OpenKey." : message}
            {/* Where conversations live, as a hint: before sign-in there is no How it works page to link to. */}
            {props.state === "unauthenticated" && (
              <InfoTip label="Where your conversations live" className="-my-3 fine:-my-1">
                Your conversations live in your TinyCloud space.
              </InfoTip>
            )}
          </p>
        </div>
        {errorLink && (
          <a href={errorLink.href} target="_blank" rel="noreferrer" className="text-callout text-primary underline underline-offset-4">
            {errorLink.label}
          </a>
        )}
        {(props.approvalReady || props.state === "unauthenticated" || props.state === "recoverableError" || props.state === "offline") && (
          <Button onClick={props.approvalAction ?? props.onAction} className="h-11 px-6 fine:h-9 fine:px-4">
            {props.approvalReady ? "Continue to OpenKey" : props.state === "offline" ? "Try again" : "Sign in"}
          </Button>
        )}
        {props.home && (
          <a href="/about" className="text-callout text-muted-foreground underline underline-offset-4">
            {LANDING_LINK_LABEL}
          </a>
        )}
        {busy && (
          <span className="text-xs text-muted-foreground">Working…</span>
        )}
        {props.voiceNotes}
      </div>
      <div className="mx-auto flex w-full max-w-sm items-end justify-center">
        <BuildInfoLine />
      </div>
    </div>
  );
}
