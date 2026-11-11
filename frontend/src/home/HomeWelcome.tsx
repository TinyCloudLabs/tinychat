// The Home site's signed-out page (TC-2387): what Home is, a sign-in, and a
// demo feed the visitor can answer, so a first visit shows the product.
import { Link } from "react-router-dom";
import { BuildInfoLine } from "@/components/BuildInfoLine";
import { Button } from "@/components/ui/button";
import type { AppState } from "@/lib/appState";
import { publicUrl } from "@/lib/basePath";
import { errorLinkFor } from "@/lib/authErrors";
import { FEED_LAB, FEED_LAB_PATH } from "@/lib/feedLab";
import { WELCOME_DEMO_NOTE, WELCOME_LEAD, WELCOME_LEARN_MORE, WELCOME_LEARN_MORE_LEAD, WELCOME_TITLE } from "@/lib/homeStrings";
import { bootMessage } from "@/shell/BootSurface";
import { AgentPromptCard } from "./AgentPromptCard";
import { HomeDemoFeed } from "./demoFeed";

export function HomeWelcome({ state, error, onSignIn }: { state: AppState; error: string | null; onSignIn: () => void }) {
  const busy = state === "connecting" || state === "signing";
  const errorLink = error ? errorLinkFor(error) : null;
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <img src={publicUrl("icons/pwa-192.png")} alt="" className="size-8 rounded-xl" />
        <span className="font-display text-headline">{WELCOME_TITLE}</span>
        <Button variant="outline" className="ml-auto h-9 px-4" disabled={busy} onClick={onSignIn}>Sign in</Button>
      </header>
      <div className="mx-auto w-full max-w-2xl min-w-0 flex-1 px-4 pb-10 pt-8 sm:px-5">
        <h1 className="font-display text-3xl font-semibold tracking-tight">{WELCOME_TITLE}</h1>
        <p className="mt-2 text-callout text-muted-foreground">{WELCOME_LEAD}</p>
        {(busy || error) && <p role="status" className="mt-3 text-sm">{bootMessage(state, error)}</p>}
        {errorLink && <a href={errorLink.href} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-primary underline underline-offset-4">{errorLink.label}</a>}
        <div className="mt-5">
          <Button className="h-11 px-6 fine:h-10 fine:px-5" disabled={busy} onClick={onSignIn}>{busy ? "Signing in…" : "Sign in to your Home"}</Button>
        </div>
        <AgentPromptCard />
        <h2 className="mt-10 text-sm font-medium">Try it</h2>
        {/* A lab build ends the note with a link to the feed lab; every other build keeps the note as it was. */}
        <p className="mb-4 mt-1 text-sm text-muted-foreground">{FEED_LAB ? <>{WELCOME_DEMO_NOTE} <Link to={FEED_LAB_PATH} className="underline underline-offset-4">Open the feed lab</Link></> : WELCOME_DEMO_NOTE}</p>
        <HomeDemoFeed />
        <p className="mt-8 text-sm text-muted-foreground">
          {WELCOME_LEARN_MORE_LEAD}{" "}
          <a href="https://tinycloud.xyz" className="underline underline-offset-4">{WELCOME_LEARN_MORE}</a>
        </p>
      </div>
      <div className="flex justify-center py-3"><BuildInfoLine /></div>
    </div>
  );
}
