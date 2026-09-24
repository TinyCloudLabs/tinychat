import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentSetupCard } from './AgentSetupCard';
const owner = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';

function promptFrom(html: string) {
  return html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]
    ?.replaceAll('&quot;', '"').replaceAll('&#x27;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function contextFrom(html: string) {
  return JSON.parse(promptFrom(html)?.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '{}');
}

describe('external agent setup', () => {
  it('supplies actual app configuration and signed-in owner in the copyable prompt', () => {
    const html = renderToStaticMarkup(<AgentSetupCard did={owner} hosts={['https://custom.example']} />);
    expect(contextFrom(html)).toEqual({
      schemaVersion: 1, host: 'https://custom.example', space: 'applications',
      expectedOwner: owner,
    });
    expect(html).toContain('Copy setup prompt');
  });

  it('allows browser identity selection when no independent owner is available', () => {
    const html = renderToStaticMarkup(<AgentSetupCard did={null} hosts={['https://custom.example']} />);
    expect(contextFrom(html)).toEqual({ schemaVersion: 1, host: 'https://custom.example', space: 'applications' });
    expect(html).toContain('Copy setup prompt');
  });

  for (const hosts of [[], ['https://one.example', 'https://two.example'], ['not-a-url'], ['https://custom.example/path'], ['http://custom.example']]) {
    it(`reports a setup issue instead of inventing a host for ${JSON.stringify(hosts)}`, () => {
      const html = renderToStaticMarkup(<AgentSetupCard did={null} hosts={hosts} />);
      expect(html).toContain('role="alert"');
      expect(promptFrom(html)).toBeUndefined();
      expect(html).not.toContain('Copy setup prompt');
    });
  }

  for (const did of ['did:key:z6Mkexample', 'did:pkh:eip155:1:0xexample', 'did:pkh:eip155:0:0x1111111111111111111111111111111111111111']) {
    it(`rejects an unsupported signing identity: ${did}`, () => {
      const html = renderToStaticMarkup(<AgentSetupCard did={did} hosts={['https://custom.example']} />);
      expect(html).toContain('role="alert"');
      expect(promptFrom(html)).toBeUndefined();
    });
  }

  it('allows HTTP for a local data host', () => {
    const html = renderToStaticMarkup(<AgentSetupCard did={owner} hosts={['http://127.0.0.1:8000']} />);
    expect(contextFrom(html).host).toBe('http://127.0.0.1:8000');
  });
});
