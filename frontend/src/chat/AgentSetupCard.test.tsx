import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSetupCard } from './AgentSetupCard';
import setup from '../lib/agent-setup.json';

describe('external agent setup', () => {
  it('offers the exact public prompt without embedding account information or private session data', () => {
    const html = renderToStaticMarkup(<AgentSetupCard did="did:pkh:eip155:1:0xexample" hosts={['https://node.example']} />);
    const textArea = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1];
    expect(textArea).toBe(setup.prompt);
    expect(textArea).not.toContain('0xexample');
    expect(html).toContain('did:pkh:eip155:1:0xexample');
    expect(html).toContain('https://node.example');
    expect(html).toContain('applications');
    expect(html).toContain('Use with your agent');
    expect(html).toContain('Copy setup prompt');
    expect(html).toContain('https://tinycloud.chat/agents/');
  });
  it('leaves an unknown location explicit rather than choosing a different node', () => {
    const html = renderToStaticMarkup(<AgentSetupCard did={null} hosts={[]} />);
    expect(html).toContain('Sign in to see your identity');
    expect(html).toContain('Host unavailable');
    expect(html).not.toContain('node.tinycloud.xyz');
  });
});
