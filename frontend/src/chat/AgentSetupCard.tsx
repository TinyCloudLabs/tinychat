import { useState } from 'react';
import { CheckIcon, CopyIcon, ExternalLinkIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/ui/section-card';
import setup from '../lib/agent-setup.json';
import { buildSetupPrompt } from '../lib/agent-setup-prompt.mjs';

export function AgentSetupCard() {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const prompt = buildSetupPrompt(setup);
  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }
  return (
    <SectionCard icon={TerminalIcon} title="Use with your agent">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Paste this into your agent. Sign in with your TinyChat account when prompted.
      </p>
      <label htmlFor="agent-setup-prompt" className="mt-4 block text-xs font-medium">Prompt</label>
      <textarea
        id="agent-setup-prompt"
        readOnly
        value={prompt}
        rows={2}
        onFocus={event => event.currentTarget.select()}
        className="mt-1.5 w-full resize-y rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={copy} className="gap-1.5">
          {copyState === 'copied' ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          {copyState === 'copied' ? 'Copied' : 'Copy prompt'}
        </Button>
        <a href={setup.setupUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">
          Setup details <ExternalLinkIcon className="size-3" />
        </a>
      </div>
      <p role="status" aria-live="polite" className="mt-2 text-xs text-muted-foreground">
        {copyState === 'failed' ? 'Copy unavailable. Select the prompt above and copy it manually.' : copyState === 'copied' ? 'Ready to paste into your agent.' : null}
      </p>
    </SectionCard>
  );
}
