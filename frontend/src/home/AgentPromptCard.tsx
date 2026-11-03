// The Home site's second call to action (TC-2387): the prompt an owner pastes
// into their agent so it connects to their Home feed, with a copy button.
import { useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WELCOME_AGENT_BODY, WELCOME_AGENT_COPIED, WELCOME_AGENT_COPY, WELCOME_AGENT_COPY_FAILED, WELCOME_AGENT_PROMPT, WELCOME_AGENT_TITLE,
} from "@/lib/homeStrings";

export function AgentPromptCard() {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const promptRef = useRef<HTMLParagraphElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(WELCOME_AGENT_PROMPT);
      setStatus("copied");
    } catch {
      // No clipboard (permission or an old browser): select the text so the owner can copy it.
      const selection = window.getSelection();
      if (promptRef.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(promptRef.current);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setStatus("failed");
    }
  }
  return (
    <section aria-labelledby="home-agent-prompt" className="mt-6 rounded-2xl border border-border bg-card p-4 text-card-foreground sm:p-5">
      <h2 id="home-agent-prompt" className="font-display text-lg font-semibold">{WELCOME_AGENT_TITLE}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{WELCOME_AGENT_BODY}</p>
      <p ref={promptRef} className="mt-3 select-all rounded-lg bg-muted px-3 py-2 font-mono text-sm [overflow-wrap:anywhere]">{WELCOME_AGENT_PROMPT}</p>
      <div className="mt-3 flex items-center gap-3">
        <Button variant="outline" className="h-10 px-4" onClick={() => void copy()}>
          {status === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}{WELCOME_AGENT_COPY}
        </Button>
        <span role="status" className="text-sm text-muted-foreground">
          {status === "copied" ? WELCOME_AGENT_COPIED : status === "failed" ? WELCOME_AGENT_COPY_FAILED : ""}
        </span>
      </div>
    </section>
  );
}
