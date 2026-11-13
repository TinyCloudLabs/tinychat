import { useState } from "react";
import { FileTextIcon } from "lucide-react";
import { lazyTab } from "@/shell/lazyTab";
import type { Brief } from "./brief";

/** The brief's sheet and its reader, in a chunk of their own: boot never needs them (TC-2882). */
export const LazyBriefSheet = lazyTab("the brief", () => import("./BriefSheet").then((module) => module.BriefSheet));

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
    <LazyBriefSheet brief={brief} open={open} onOpenChange={setOpen} />
  </>;
}
