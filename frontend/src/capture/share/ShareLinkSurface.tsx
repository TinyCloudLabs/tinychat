// TC-3195: /s/<id>, a link someone sent you (approved mock, screen 3). It says who shared what: the owner from the
// owner's signature (in sentences short, under the headline whole), the title and details as the link carries them
// (in quotes, captioned as unchecked). Nothing is added until you ask: "Sign in to add" adds it once you are signed
// in, and a signed-in account taps "Add to Library". Then the recording opens.
// The link (and its key) was read and removed from the address bar before the app rendered (link.ts); it lives in
// memory only and is let go once the share is in your TinyCloud.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { AudioLinesIcon, Link2OffIcon, LoaderCircleIcon, SmartphoneIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import type { AppState } from "@/lib/appState";
import { PRODUCT_PAGE_URL } from "@/lib/homeSite";
import { includesLabel, LINK_DETAILS_CAPTION, parseRecordingDisplay, quotedTitle, type RecordingShareDisplay } from "@/lib/nativeShares/display";
import { heldShareLink, releaseShareLink, shareLinkId } from "@/lib/nativeShares/link";
import { firstShareFrom, receivedShareFor, receivedShareRecord, receivedShares, sharedNoteId, useReceivedShares } from "@/lib/nativeShares/receivedShares";
import { claimShare, openShareLink, ShareLinkError, type OpenedShareLink } from "@/lib/nativeShares/sdk";
import { bootMessage } from "@/shell/BootSurface";
import { notePath } from "@/shell/routes";
import { Sender, SenderAddress } from "./Sender";
import { shareItemLine } from "./shareCopy";

type Problem = "expired" | "invalid" | "unavailable" | "revoked" | "claim-failed";

type View =
  | { status: "opening" }
  | { status: "open"; link: OpenedShareLink; display: RecordingShareDisplay }
  | { status: "problem"; problem: Problem; link?: OpenedShareLink; display?: RecordingShareDisplay };

const PROBLEM_COPY: Record<Exclude<Problem, "revoked">, { title: string; description: string; retry: boolean }> = {
  expired: { title: "This link has expired", description: "Ask the person who shared it for a new link.", retry: false },
  invalid: { title: "This link can’t be opened", description: "Check that you copied the whole link.", retry: false },
  unavailable: { title: "Couldn’t open this link", description: "Check your connection, then try again.", retry: true },
  "claim-failed": { title: "Couldn’t add this recording", description: "Check your connection, then try again.", retry: true },
};

function Shell(props: { children: ReactNode }) {
  return (
    <main className="h-full pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]" data-testid="share-link-surface">
      <div className="flex min-h-full flex-col overflow-y-auto">
        <header className="flex items-center gap-3 border-b border-border px-4 py-3">
          <img src="/icons/pwa-192.png" alt="" className="size-8 rounded-xl" />
          <span className="font-display text-headline">TinyCloud One</span>
        </header>
        <div className="mx-auto flex w-full min-w-0 max-w-md flex-1 flex-col px-4 pb-10 pt-10 lg:pt-20">{props.children}</div>
      </div>
    </main>
  );
}

function openProblem(error: unknown): Problem {
  if (!(error instanceof ShareLinkError)) return "unavailable";
  return error.code === "gone" || error.code === "expired" ? "expired" : error.code;
}

export function ShareLinkSurface(props: { tcw: TinyCloudWeb | null; state: AppState; error: string | null; onSignIn: () => void; now?: () => Date }) {
  const navigate = useNavigate();
  const now = (props.now ?? (() => new Date()))();
  const [view, setView] = useState<View>({ status: "opening" });
  const [attempt, setAttempt] = useState(0);
  // The account's Library, for the first-share mark (App binds it to the signed-in account).
  const shared = useReceivedShares();
  // The recipient asked for the share: by signing in from this page, or with "Add to Library".
  const [addRequested, setAddRequested] = useState(false);
  const claiming = useRef(false);
  const linkId = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const href = heldShareLink();
    linkId.current = href ? shareLinkId(href) : null;
    if (!href || !linkId.current) {
      setView({ status: "problem", problem: "invalid" });
      return;
    }
    setView({ status: "opening" });
    openShareLink(href).then((link) => {
      if (!active) return;
      const display = parseRecordingDisplay(link.display);
      setView(display ? { status: "open", link, display } : { status: "problem", problem: "invalid" });
    }, (error: unknown) => {
      if (active) setView({ status: "problem", problem: openProblem(error) });
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  const tcw = props.tcw;
  useEffect(() => {
    const id = linkId.current;
    if (view.status !== "open" || !tcw?.did || !id || !addRequested || claiming.current) return;
    claiming.current = true;
    const { link, display } = view;
    const open = (recordId: string, added: boolean) => {
      releaseShareLink();
      navigate(notePath(sharedNoteId(recordId)), { replace: true, state: added ? { shareAdded: true } : null });
    };
    void (async () => {
      // One delegation per share: a share this account already added (from any link) opens its record unchanged,
      // and when whether it was added cannot be read, nothing is claimed.
      const existing = await receivedShareFor(tcw, link.rootCid);
      if (existing === undefined) {
        setView({ status: "problem", problem: "claim-failed", link, display });
        return;
      }
      if (existing) {
        open(existing.id, false);
        return;
      }
      const claimed = await claimShare(tcw, link.token);
      if (!claimed.ok) {
        setView({ status: "problem", problem: claimed.reason === "failed" ? "claim-failed" : claimed.reason, link, display });
        return;
      }
      const record = receivedShareRecord(link, display, claimed.share, new Date(), id);
      try {
        await receivedShares.put(tcw, record);
      } catch {
        setView({ status: "problem", problem: "claim-failed", link, display });
        return;
      }
      open(record.id, true);
    })().finally(() => {
      claiming.current = false;
    });
  }, [view, tcw, addRequested, navigate]);

  if (view.status === "problem") {
    if (view.problem === "revoked" && view.display && view.link) {
      const sender = <Sender address={view.link.owner.address} />;
      return (
        <Shell>
          <div className="flex flex-col items-start gap-2" data-testid="share-link-revoked">
            <span aria-hidden="true" className="mb-1 flex size-10 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground [&_svg]:size-5"><Link2OffIcon /></span>
            <h1 className="text-headline">{sender} stopped sharing this recording</h1>
            <p className="max-w-[34ch] text-callout text-muted-foreground">It’s no longer available to you. Ask {sender} if you need it again.</p>
            <div className="mt-1">
              <SenderAddress address={view.link.owner.address} firstShare={tcw !== null && firstShareFrom(shared, view.link.owner.address) === true} />
            </div>
          </div>
        </Shell>
      );
    }
    const copy = PROBLEM_COPY[view.problem === "revoked" ? "expired" : view.problem];
    return (
      <Shell>
        <div className="flex flex-col items-start gap-2" data-testid="share-link-problem" data-problem={view.problem}>
          <h1 className="font-display text-title-1 [font-size:min(1.75rem,8vw)]">{copy.title}</h1>
          <p className="text-callout text-muted-foreground">{copy.description}</p>
          {copy.retry && (
            <Button type="button" variant="outline" className="mt-4" onClick={() => {
              if (view.problem === "claim-failed" && view.link && view.display) setView({ status: "open", link: view.link, display: view.display });
              else setAttempt((n) => n + 1);
            }}>Try again</Button>
          )}
        </div>
      </Shell>
    );
  }

  if (view.status === "opening") {
    return (
      <Shell>
        <div role="status" className="flex justify-center py-10 text-muted-foreground">
          <LoaderCircleIcon aria-hidden="true" className="size-6 animate-spin motion-reduce:animate-none" />
          <span className="sr-only">Opening the link…</span>
        </div>
      </Shell>
    );
  }

  const { link, display } = view;
  const sender = <Sender address={link.owner.address} />;
  const busy = props.state === "connecting" || props.state === "signing";
  return (
    <Shell>
      <p className="text-meta font-semibold text-muted-foreground">Shared with you</p>
      <h1 className="mt-1 font-display text-title-1 [font-size:min(1.75rem,8vw)] [overflow-wrap:anywhere]">{sender} shared a recording with you</h1>
      <div className="mt-3">
        <SenderAddress address={link.owner.address} firstShare={tcw !== null && firstShareFrom(shared, link.owner.address) === true} />
      </div>
      <div className="mt-6 flex items-center gap-3 rounded-lg border border-border p-3">
        <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground"><AudioLinesIcon className="size-5" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body font-medium [overflow-wrap:anywhere]">{quotedTitle(display.title)}</span>
          <span className="text-meta text-muted-foreground">{shareItemLine(display, now)} · {includesLabel(display.includes)}</span>
          <span className="text-meta text-muted-foreground">{LINK_DETAILS_CAPTION}</span>
        </span>
      </div>
      <div className="mt-6 flex flex-col gap-3">
        {tcw && addRequested ? (
          <div role="status" className="flex h-11 items-center justify-center text-muted-foreground fine:h-10">
            <LoaderCircleIcon aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">Adding it to your TinyCloud…</span>
          </div>
        ) : tcw ? (
          <Button type="button" className="h-11 w-full fine:h-10" onClick={() => setAddRequested(true)}>Add to Library</Button>
        ) : (
          <Button type="button" className="h-11 w-full fine:h-10" disabled={busy} onClick={() => {
            setAddRequested(true);
            props.onSignIn();
          }}>{busy ? "Signing in…" : "Sign in to add"}</Button>
        )}
        <p className="text-callout text-muted-foreground">{tcw ? "" : "Signing in adds it to your Library. "}{sender} can stop sharing at any time, and then it’s no longer available to you.</p>
        {props.error && <p role="status" className="text-callout">{bootMessage(props.state, props.error)}</p>}
      </div>
      <div className="mt-auto pt-10">
        <div className="flex items-center gap-3 rounded-lg border border-border p-3 lg:hidden">
          <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground"><SmartphoneIcon className="size-5" /></span>
          <p className="min-w-0 flex-1 text-callout">Have the app? This link opens there too.</p>
          <a href={PRODUCT_PAGE_URL} target="_blank" rel="noopener noreferrer" className="shrink-0 text-callout font-medium text-primary underline underline-offset-4">Get the app</a>
        </div>
        {!tcw && <p className="mt-4 text-meta text-muted-foreground">New to TinyCloud? Signing in creates your space. It’s free.</p>}
      </div>
    </Shell>
  );
}
