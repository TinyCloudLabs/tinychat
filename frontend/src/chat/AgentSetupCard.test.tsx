import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSetupCard } from './AgentSetupCard';

const prompt = 'How did my last meeting go? Check TinyCloud: https://tinycloud.chat/agents/setup.md';

describe('external agent prompt', () => {
  it('shows the exact one-line production prompt without setup details', () => {
    const html = renderToStaticMarkup(<AgentSetupCard />);
    const value = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
    expect(value).toBe(prompt);
    expect(html).toContain('Copy prompt');
    expect(html).not.toMatch(/SKILL\.md|\$HOME|expectedOwner|configPath|--activate/);
  });

  it('links to public setup without claiming to include the signed-in identity', () => {
    const html = renderToStaticMarkup(<AgentSetupCard />);
    expect(html).toContain('href="https://tinycloud.chat/agents/"');
    expect(html).toContain('Sign in with your TinyChat account');
    expect(html).not.toContain('account is included');
    expect(html).not.toContain('settings are included');
  });
});
