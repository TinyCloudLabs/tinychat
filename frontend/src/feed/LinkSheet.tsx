// The web sheet a Feed link opens in (TC-3404, inAppLink.ts): it rises from the bottom over the Feed, with the
// page's site, "Open in browser" and Close always in its header. Drag down, the scrim, Escape or Close shuts it
// (BottomSheet: focus trap, focus return, reduced motion). From 640px it is capped in width and centred.
//
// The page shows in a sandboxed frame on its own origin and is sent no referrer. A page that refuses
// to be framed shows the browser's own error in the frame and gives no signal the app can read, so sites known to
// refuse get a note instead, and every frame has a hint under it.
import { useRef, useState } from "react";
import { ArrowUpRightIcon, XIcon } from "lucide-react";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { displayHost, refusesFraming } from "./inAppLink";

const buttonClass = "inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-foreground transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2 fine:min-h-10";

function OpenInBrowser({ url }: { url: string }) {
  return <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClass}>
    Open in browser<ArrowUpRightIcon aria-hidden className="size-4" />
  </a>;
}

/** A page from another site in a sheet over the Feed. Controlled: the caller owns `open`; `opener` gets focus back on close. */
export function LinkSheet({ url, open, opener, onOpenChange }: { url: string; open: boolean; opener?: HTMLElement; onOpenChange: (open: boolean) => void }) {
  const host = displayHost(url);
  // The address whose frame has loaded; a sheet that switches pages shows "Loading" again.
  const [loaded, setLoaded] = useState<string>();
  // The shared sheet leaves focus where it was on open and returns it to no trigger on close: a keyboard user lands on
  // Close, inside the sheet's focus trap, and is back on the link that opened it after.
  const closeRef = useRef<HTMLButtonElement>(null);
  return <BottomSheet open={open} onOpenChange={onOpenChange} height="full" bare title={host}
    onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus({ preventScroll: true }); }}
    onCloseAutoFocus={(event) => { if (opener?.isConnected) { event.preventDefault(); opener.focus({ preventScroll: true }); } }}
    className="sm:mx-auto sm:w-[calc(100%-2rem)] sm:max-w-4xl" contentProps={{ "data-link-sheet": "" }}>
    <div className="flex shrink-0 items-center gap-2 border-b border-border py-1.5 pl-4 pr-2">
      <div className="min-w-0 flex-1">
        <p aria-hidden className="truncate font-display text-headline">{host}</p>
        <p className="truncate text-meta text-muted-foreground">{url}</p>
      </div>
      <OpenInBrowser url={url} />
      <button ref={closeRef} type="button" aria-label="Close" onClick={() => onOpenChange(false)}
        className="tap-transparent flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-surface-2">
        <XIcon aria-hidden className="size-5" />
      </button>
    </div>
    {refusesFraming(url)
      ? <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-callout font-medium">{host} only opens in a browser.</p>
        <OpenInBrowser url={url} />
      </div>
      : <>
        <div className="relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-white">
          <iframe key={url} src={url} title={`Page from ${host}`} onLoad={() => setLoaded(url)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            referrerPolicy="no-referrer" allow="" className="block size-full" />
          {loaded !== url && <p role="status" className="absolute inset-0 flex items-center justify-center bg-card text-callout text-muted-foreground">Loading {host}…</p>}
        </div>
        <p className="shrink-0 px-4 pb-2 text-meta text-muted-foreground">Page not showing? Some sites only open in a browser.</p>
      </>}
  </BottomSheet>;
}
