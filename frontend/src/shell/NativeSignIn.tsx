// Exo's own first screen on iOS and Android (TC-941). It collects only an
// email address and the chosen method; the code, the passkey and Google's
// pages all happen on openkey.so in the system sheet, which opens on the step
// these hints name. App.tsx shows it only where `isNativeOpenKeySignIn()`.
import { KeyRoundIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { BuildInfoLine } from "@/components/BuildInfoLine";
import { Button } from "@/components/ui/button";
import type { AppState } from "../lib/appState";
import { errorLinkFor } from "../lib/authErrors";
import { normalizeLoginHint, type NativeSignInHints } from "../lib/openkeyNative";
import { bootMessage } from "./BootSurface";

export const NATIVE_SIGN_IN_SUBCOPY = "Your notes and recordings sync to your own TinyCloud space.";
export const NATIVE_SIGN_IN_FINE_PRINT = "You'll finish on openkey.so. Exo never sees your code or passkey.";

// The shared Button never wraps and has a fixed height; at large text sizes these
// labels need to wrap and the button to grow with them.
const WRAPPING_BUTTON = "h-auto min-h-12 w-full whitespace-normal py-2 text-center";

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden className="!size-[18px]">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  );
}

export function NativeSignIn(props: {
  state: AppState;
  error: string | null;
  onSignIn: (hints: NativeSignInHints) => void;
  /** Back to the local home this screen was opened from; absent when there is none to go back to. */
  onClose?: () => void;
}) {
  const [email, setEmail] = useState("");
  const loginHint = normalizeLoginHint(email);
  const busy = props.state === "connecting" || props.state === "signing";
  const errorLink = errorLinkFor(props.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || loginHint === null) return;
    props.onSignIn({ loginHint, loginMethod: "email" });
  };

  return (
    <div className="flex min-h-full flex-col overflow-y-auto px-6 pb-6 pt-8" data-testid="native-sign-in">
      <div className="mx-auto flex w-full min-w-0 max-w-sm flex-1 flex-col gap-6">
        <div className="flex flex-col gap-4 pt-4">
          <img src="/icons/pwa-192.png" alt="" className="size-16 rounded-2xl" />
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-title-1">Sign in to Exo</h1>
            <p className="text-callout text-muted-foreground">{NATIVE_SIGN_IN_SUBCOPY}</p>
          </div>
        </div>
        {busy && <p role="status" className="text-callout text-muted-foreground">{bootMessage(props.state, props.error)}</p>}
        {!busy && props.error && (
          <div role="alert" className="flex flex-col gap-2 text-callout text-destructive">
            <p>{props.error}</p>
            {errorLink && (
              <a href={errorLink.href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-4">
                {errorLink.label}
              </a>
            )}
          </div>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <input
            type="email"
            name="email"
            onInput={(event) => setEmail(event.currentTarget.value)}
            autoComplete="email"
            inputMode="email"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            placeholder="Email address"
            aria-label="Email address"
            disabled={busy}
            className="h-12 w-full rounded-md border border-input bg-background px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <Button type="submit" size="lg" className={WRAPPING_BUTTON} disabled={busy || loginHint === null}>Continue</Button>
        </form>
        <div role="separator" className="flex items-center gap-3 text-meta text-muted-foreground">
          <span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" />
        </div>
        <div className="flex flex-col gap-3">
          <Button type="button" variant="outline" size="lg" className={WRAPPING_BUTTON} disabled={busy}
            onClick={() => props.onSignIn({ loginMethod: "google" })}>
            <GoogleMark /><span className="min-w-0">Continue with Google</span>
          </Button>
          <Button type="button" variant="outline" size="lg" className={WRAPPING_BUTTON} disabled={busy}
            onClick={() => props.onSignIn({ loginMethod: "passkey" })}>
            <KeyRoundIcon aria-hidden /><span className="min-w-0">Use a passkey</span>
          </Button>
        </div>
      </div>
      <div className="mx-auto mt-8 flex w-full max-w-sm flex-col items-center gap-3 text-center">
        {props.onClose && <Button type="button" variant="ghost" disabled={busy} onClick={props.onClose}>Not now</Button>}
        <p className="text-meta text-muted-foreground">{NATIVE_SIGN_IN_FINE_PRINT}</p>
        <BuildInfoLine className="[overflow-wrap:anywhere]" />
      </div>
    </div>
  );
}
