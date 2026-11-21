// `/chat/apps/add` (One's new navigation, ONE_NAV_ENABLED): the builder prompt for making a TinyCloud app with a coding agent, to copy. Not a tab
// and no Back: the navigation's Apps item is current here and leads back to the grid. Copying follows
// chat/AgentSetupCard.tsx.
import { useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PAGE_COLUMN, PageHeader } from "@/shell/PageHeader";
import {
  ADD_APP_LEAD,
  ADD_APP_PROMPT,
  ADD_APP_PROMPT_LABEL,
  ADD_APP_REVIEW_NOTE,
  ADD_APP_TITLE,
  COPIED,
  COPY_FAILED,
  COPY_PROMPT,
  SHOW_REVIEW_NOTE,
} from "./strings";

export function AddAppPage() {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(ADD_APP_PROMPT);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={ADD_APP_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        <p className="text-body text-muted-foreground">{ADD_APP_LEAD}</p>
        {SHOW_REVIEW_NOTE ? <p className="text-callout text-muted-foreground">{ADD_APP_REVIEW_NOTE}</p> : null}
        <label htmlFor="add-app-prompt" className="mt-2 block text-meta font-medium text-foreground">
          {ADD_APP_PROMPT_LABEL}
        </label>
        <textarea
          id="add-app-prompt"
          readOnly
          value={ADD_APP_PROMPT}
          rows={12}
          onFocus={(event) => event.currentTarget.select()}
          // 16 px on touch, so iOS doesn't zoom into it on focus.
          className="w-full resize-y rounded-md border border-border bg-muted/30 p-3 font-mono text-body leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:text-meta"
        />
        <div>
          <Button type="button" variant="outline" onClick={copy} className="gap-1.5">
            {copyState === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copyState === "copied" ? COPIED : COPY_PROMPT}
          </Button>
        </div>
        <p role="status" aria-live="polite" className="text-meta text-muted-foreground">
          {copyState === "failed" ? COPY_FAILED : copyState === "copied" ? <span className="sr-only">{COPIED}</span> : null}
        </p>
      </div>
    </div>
  );
}
