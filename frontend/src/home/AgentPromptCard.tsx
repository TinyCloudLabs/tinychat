// The Home site's second call to action (TC-2387): the prompt an owner pastes
// into their agent so it connects to their Home feed, with a copy button.
import { useRef, useState, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  WELCOME_AGENT_BODY, WELCOME_AGENT_COPIED, WELCOME_AGENT_COPY, WELCOME_AGENT_COPY_FAILED, WELCOME_AGENT_PROMPT, WELCOME_AGENT_TITLE,
} from "@/lib/homeStrings";

/**
 * The prompt block and its "Copy prompt" button. `copyButton` styles the button
 * for its surface (the signed-out page's outline button, or the empty Home
 * card's ink pill); `aside` sits beside it.
 */
export function AgentPrompt({ copyButton, aside }: { copyButton: (props: { onClick: () => void; children: ReactNode }) => ReactNode; aside?: ReactNode }) {
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
  return <>
    <p ref={promptRef} className="mt-3 select-all rounded-xl bg-muted px-4 py-3 font-mono text-sm [overflow-wrap:anywhere]">{WELCOME_AGENT_PROMPT}</p>
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
      {copyButton({ onClick: () => void copy(), children: <>{status === "copied" ? <CheckIcon aria-hidden className="size-4" /> : <CopyIcon aria-hidden className="size-4" />}{WELCOME_AGENT_COPY}</> })}
      {aside}
      <span role="status" className="text-sm text-muted-foreground">
        {status === "copied" ? WELCOME_AGENT_COPIED : status === "failed" ? WELCOME_AGENT_COPY_FAILED : ""}
      </span>
    </div>
  </>;
}

export function AgentPromptCard() {
  return (
    <section aria-labelledby="home-agent-prompt" className="mt-6 rounded-2xl border border-border bg-card p-4 text-card-foreground sm:p-5">
      <h2 id="home-agent-prompt" className="font-display text-lg font-semibold">{WELCOME_AGENT_TITLE}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{WELCOME_AGENT_BODY}</p>
      <AgentPrompt copyButton={({ onClick, children }) => <Button variant="outline" className="h-10 px-4" onClick={onClick}>{children}</Button>} />
    </section>
  );
}
