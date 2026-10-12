// The build line (TC-840): one muted, selectable line — target, version,
// build number and commit — at the foot of the boot surface, the desktop
// sidebar and the bottom of Settings. A tap copies it and swaps the line for
// "Copied" for a moment (a toast announced politely, without a floating layer).
import { useContext, useEffect, useRef, useState } from "react";

import { resolveBuildInfo } from "@/lib/buildInfo";
import { copyText } from "@/lib/copyText";
import { PlatformContext } from "@/lib/platform";
import { cn } from "@/lib/utils";

export function BuildInfoLine({ className }: { className?: string }) {
  const platform = useContext(PlatformContext);
  // Empty until the first resolve lands. min-h-[6em] reserves ~4 lines at the
  // line's own font size: at 200% text on a phone the full native line (build
  // number, bundle id and sha) still fits inside it, so the footer — and the
  // centred content the footer's row shares space with — never moves.
  const [line, setLine] = useState("");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void resolveBuildInfo(platform).then((text) => {
      if (live) setLine(text);
    });
    return () => {
      live = false;
    };
  }, [platform]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );

  return (
    <button
      type="button"
      data-testid="build-info"
      aria-label={copied ? "Build information copied" : `Copy build information: ${line}`}
      disabled={!line}
      onClick={() => {
        void copyText(line).then((ok) => {
          if (!ok) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        });
      }}
      className={cn(
        "tap-transparent flex min-h-[6em] w-full select-text items-center justify-center text-center text-meta leading-snug text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default",
        className,
      )}
    >
      {copied ? "Copied" : line}
      {/* fixed: an sr-only absolute span with no positioned ancestor resolves
          against the document and would extend its scrollable overflow. */}
      <span className="sr-only fixed" aria-live="polite" aria-atomic="true">
        {copied ? "Build information copied to clipboard" : ""}
      </span>
    </button>
  );
}
