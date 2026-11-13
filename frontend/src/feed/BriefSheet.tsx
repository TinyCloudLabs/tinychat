// A card's brief (Sam 11-12: "you want all the context you need to make a decision when you're making a
// decision here"): a one-page, fully contextual page an agent attaches to a card as `payload.brief`. It opens inside
// the app, never a new tab, so the card and its options are still there when you close it. On a phone (under 640px)
// it fills the screen and rises from the bottom; from 640px up it is a large centred dialog that scales in. Radix
// gives the focus trap, Escape, scrim close and focus return to "Read the brief". With reduced motion it neither
// slides nor scales: it just appears and disappears.
//
// The brief is Markdown carried on the card, or the address of a .md or .html page. Markdown is rendered by
// BriefMarkdown.tsx (never as HTML); an .html page shows in a sandboxed frame with no script and no access to the app.
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileTextIcon, XIcon } from "lucide-react";
import { BriefMarkdown } from "./BriefMarkdown";

/** A card's brief: `markdown` carried inline, or `url`, a .md or .html page on this host or on https. */
export interface Brief {
  title: string;
  markdown?: string;
  url?: string;
}

// Past this a brief is no longer one page, and rendering it would stall the sheet.
const MAX_MARKDOWN = 100_000;

/**
 * The page a brief's `url` names, when the sheet can open it: a path on this host, or an absolute address on this
 * origin or on https, ending .md or .html. Anything else (http elsewhere, javascript:, data:, other file types) is no
 * brief.
 */
function briefPage(value: string): { href: string; format: "markdown" | "html" } | undefined {
  if (value.length > 2048) return undefined;
  const here = typeof window === "undefined" ? undefined : window.location.href;
  const onThisHost = value.startsWith("/") && !value.startsWith("//");
  let url: URL;
  try {
    // A path can only be resolved in the browser; elsewhere (tests, the server render) a placeholder host parses it.
    url = new URL(value, here ?? "https://this-host.invalid");
  } catch {
    return undefined;
  }
  const sameOrigin = onThisHost || (here !== undefined && url.origin === new URL(here).origin);
  if (!sameOrigin && url.protocol !== "https:") return undefined;
  const path = url.pathname.toLowerCase();
  const format = /\.(md|markdown)$/.test(path) ? "markdown" : /\.html?$/.test(path) ? "html" : undefined;
  return format && { href: here ? url.href : value, format };
}

/** A card payload's brief, if it carries a well-formed one (`payload.brief`). Markdown wins when both are given. */
export function briefOf(payload: Record<string, unknown> | undefined): Brief | undefined {
  const value = payload?.brief;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { title, markdown, url } = value as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || title.length > 200) return undefined;
  if (typeof markdown === "string" && markdown.trim() && markdown.length <= MAX_MARKDOWN) return { title: title.trim(), markdown };
  if (typeof url === "string" && briefPage(url)) return { title: title.trim(), url };
  return undefined;
}

async function readBriefPage(href: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(href, { cache: "no-cache", signal });
  // A missing file on a single-page host comes back as the app's own index.html, with a 200.
  if (!response.ok || (response.headers.get("content-type") ?? "").includes("text/html")) throw new Error("Brief unavailable");
  const text = await response.text();
  if (text.length > MAX_MARKDOWN) throw new Error("Brief too long");
  return text;
}

function Unavailable({ href }: { href?: string }) {
  return <div className="space-y-3 text-callout text-muted-foreground">
    <p>This brief couldn’t be opened.</p>
    {/* The one way out of the app: only when the page itself could not be read here. */}
    {href && <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-10">Open it in a new tab</a>}
  </div>;
}

/** A .md brief page, read when the sheet opens. */
function BriefPage({ href }: { href: string }) {
  const [read, setRead] = useState<{ href: string; text?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    readBriefPage(href, controller.signal).then(
      (text) => { if (!controller.signal.aborted) setRead({ href, text }); },
      () => { if (!controller.signal.aborted) setRead({ href }); },
    );
    return () => controller.abort();
  }, [href]);
  // Keyed by the address, so a sheet that switches briefs never shows the previous one's text.
  if (read?.href !== href) return <p role="status" className="text-callout text-muted-foreground">Loading the brief…</p>;
  if (read.text === undefined) return <Unavailable href={href} />;
  return <BriefMarkdown markdown={read.text} base={href} />;
}

/** A brief in a sheet titled with its title. Controlled: the caller owns `open`. */
export function BriefSheet({ brief, open, onOpenChange }: {
  brief: Brief;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const page = brief.markdown ? undefined : brief.url ? briefPage(brief.url) : undefined;
  // An .html page fills the sheet with its frame; Markdown scrolls inside it.
  const frame = page?.format === "html" ? page.href : undefined;
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0 data-[state=open]:duration-250 data-[state=closed]:duration-150 motion-reduce:!animate-none" />
      <Dialog.Content
        aria-describedby={undefined}
        className={[
          "fixed z-50 flex flex-col bg-card text-card-foreground outline-none",
          // Phone: the whole screen, clear of the status bar, the notch and the home indicator.
          "inset-x-0 top-0 h-[var(--tc-app-height,100dvh)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]",
          // 640px up: centred with margins rather than a transform, so the keyframes' own transform cannot knock it
          // off centre mid-animation. A framed page has no height of its own, so its sheet takes the full 85%.
          "sm:inset-0 sm:m-auto sm:max-h-[min(85vh,calc(var(--tc-app-height,100dvh)-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:rounded-sheet sm:border sm:border-border sm:p-0 sm:shadow-float",
          frame ? "sm:h-[min(85vh,calc(var(--tc-app-height,100dvh)-2rem))]" : "sm:h-fit",
          // Phone motion: the sheet rises from below the screen and drops back.
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-full data-[state=closed]:slide-out-to-bottom-full data-[state=open]:duration-350 data-[state=open]:ease-drawer data-[state=closed]:duration-250 data-[state=closed]:ease-exit",
          // 640px up: a small rise, scale and fade instead, quicker on the way out.
          "sm:data-[state=open]:slide-in-from-bottom-2 sm:data-[state=closed]:slide-out-to-bottom-2 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:fade-in-0 sm:data-[state=closed]:fade-out-0 sm:data-[state=open]:duration-250 sm:data-[state=open]:ease-smooth sm:data-[state=closed]:duration-150",
          "motion-reduce:!animate-none",
        ].join(" ")}
      >
        <div className="flex shrink-0 items-start gap-2 border-b border-border py-2 pl-4 pr-2 sm:pl-6">
          <div className="min-w-0 flex-1 py-1.5">
            <p className="text-meta text-muted-foreground">Brief</p>
            <Dialog.Title className="break-words font-display text-title-2">{brief.title}</Dialog.Title>
          </div>
          <Dialog.Close aria-label="Close" className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:size-9">
            <XIcon className="size-5" />
          </Dialog.Close>
        </div>
        {frame
          ? <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
            {/* No scripts, forms or access to the app; its links may open new tabs. White behind it, as a page
                with no background of its own expects. */}
            <iframe src={frame} title={brief.title} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="min-h-0 w-full flex-1 rounded-lg border border-border bg-white" />
          </div>
          : <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6 sm:py-5">
            {brief.markdown ? <BriefMarkdown markdown={brief.markdown} /> : page ? <BriefPage href={page.href} /> : <Unavailable />}
          </div>}
        {/* On a phone the X and Escape are enough, as in Details; from 640px a footer Close. */}
        <div className="hidden shrink-0 justify-end border-t border-border px-4 py-3 sm:flex sm:px-6">
          <Dialog.Close className="min-h-11 rounded-lg border border-border px-4 text-sm transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:min-h-10">Close</Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** "Read the brief": a quiet control on an open card that opens its brief in a sheet. */
export function BriefButton({ brief, className = "" }: { brief: Brief; className?: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:min-h-10 ${className}`}
    >
      <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      Read the brief
    </button>
    <BriefSheet brief={brief} open={open} onOpenChange={setOpen} />
  </>;
}
