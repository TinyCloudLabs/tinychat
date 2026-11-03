import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSetupCard } from './AgentSetupCard';
import setup from '../lib/agent-setup.json';
import { buildSetupPrompt } from '../lib/agent-setup-prompt.mjs';

// The same builder writes the public /agents prompt, so the card and the setup page can't drift.
const prompt = buildSetupPrompt(setup);

describe('external agent prompt', () => {
  it('shows the exact one-line production prompt without setup details', () => {
    const html = renderToStaticMarkup(<AgentSetupCard />);
    const value = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
    expect(value).toBe(prompt);
    expect(html).toContain('Copy prompt');
    expect(html).not.toMatch(/SKILL\.md|\$HOME|expectedOwner|configPath|--activate/);
    expect(value).toContain('https://agents.tinycloud.xyz/chat');
    expect(value).toContain('including running its installer');
  });

  it('links to public setup without claiming to include the signed-in identity', () => {
    const html = renderToStaticMarkup(<AgentSetupCard />);
    expect(html).toContain('href="https://tinycloud.chat/agents/"');
    expect(html).toContain('Sign in with your TinyChat account');
    expect(html).not.toContain('account is included');
    expect(html).not.toContain('settings are included');
  });
});
