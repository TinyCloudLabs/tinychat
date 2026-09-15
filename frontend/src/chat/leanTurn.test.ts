import { afterEach, expect, test } from 'bun:test';
import { createChatModelAdapter } from './chatModelAdapter';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
function deps() {
  return {
    backendUrl: 'https://synthetic.test', sessionStore: { getToken: () => 'synthetic', isExpired: () => false },
    agentEnabledRef: { current: false },
    selection: {
      beginActiveTurn: async (turnId: string) => ({ turnId, threadId: 'thread', model: 'z-ai/glm-5.3', signal: new AbortController().signal }),
      waitForAppend: async () => {}, captureCancel: () => () => {}, assertActive: () => {}, setRunning: () => {},
    },
    getCheckpoint: async () => null, appendCompaction: async () => { throw Error('browser compaction must not run'); },
    summarize: async () => { throw Error('browser provider must not run'); }, contextTokensFor: () => 1,
  };
}
test('every Send reaches backend classification even with public tools off', async () => {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n');
  }) as typeof fetch;
  const adapter = createChatModelAdapter(deps() as never);
  for await (const _ of adapter.run({ messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'Hi' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'a1' } as never)) {}
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toBe('https://synthetic.test/api/agent/chat');
  expect(requests[0].body.publicTools).toBe(false);
  expect(requests[0].body.turn.turnId).toBe('u1');
});

test('restored private answers carry parent identity while their prose stays out of the next payload', async () => {
  const result = { version: 3, private: true, turnId: 'private-user', status: 'completed', text: 'PRIVATE_BODY_CANARY', sources: [{ source: 'fireflies', sourceId: 'A', meetingRef: 'A', revision: 'r1' }], citations: [], obligations: [], limitations: [], coverage: [], receipts: { modelCalls: 1, ioAttempts: 1, recovery: 'none', elapsedMs: 1 } };
  const prior = { turnId: 'private-user', sentAt: 1, status: 'completed', private: true, result };
  let body: any;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('data: [DONE]\n\n'); }) as typeof fetch;
  const adapter = createChatModelAdapter(deps() as never);
  for await (const _ of adapter.run({ messages: [
    { id: 'private-user', role: 'user', content: [{ type: 'text', text: 'PRIVATE_QUESTION_CANARY' }] },
    { id: 'private-assistant', role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_BODY_CANARY' }], metadata: { custom: { turn: prior } } },
    { id: 'u2', role: 'user', content: [{ type: 'text', text: 'the first meeting' }] },
  ], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'a2' } as never)) {}
  expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_');
  expect(body.turn.parent.sources).toEqual(result.sources);
});

test('Stop before DONE claims cancellation and rejects a late meeting result', async () => {
  const { createTurnOutcomeStore } = await import('./pendingHandoff');
  const outcomes = createTurnOutcomeStore(); const stop = new AbortController();
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = (async () => new Response(new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"draft"}}]}\n\n')); } }))) as typeof fetch;
  const adapter = createChatModelAdapter({ ...deps(), turnOutcomes: outcomes } as never);
  for await (const frame of adapter.run({ messages: [{ id: 'stop-user', role: 'user', content: [{ type: 'text', text: 'Summarize' }] }], abortSignal: stop.signal, context: {}, unstable_assistantMessageId: 'stop-answer' } as never)) {
    if (frame.content) stop.abort();
  }
  expect(outcomes.get('thread', 'stop-user')?.status).toBe('cancelled');
  expect(outcomes.claim('thread', { turnId: 'stop-user', sentAt: 1, status: 'completed', private: false })).toBe(false);
});

test('a checkpoint read cannot hold the turn past its remaining Send deadline', async () => {
  const { createTurnOutcomeStore } = await import('./pendingHandoff');
  const outcomes = createTurnOutcomeStore();
  const adapter = createChatModelAdapter({ ...deps(), turnOutcomes: outcomes, getCheckpoint: () => new Promise(() => {}) } as never);
  const run = (async () => { for await (const _ of adapter.run({ messages: [{ id: 'deadline-user', role: 'user', createdAt: new Date(Date.now() - 119980), content: [{ type: 'text', text: 'hi' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'deadline-answer' } as never)) {} return 'settled'; })();
  expect(await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('hung'), 100))])).toBe('settled');
  expect(outcomes.get('thread', 'deadline-user')?.status).toBe('failed');
});

for (const status of ['completed', 'partial', 'unavailable', 'failed', 'cancelled', 'clarification_required'] as const) {
  test(`persists product status ${status} separately from complete stream framing`, async () => {
    const { createTurnOutcomeStore } = await import('./pendingHandoff');
    const outcomes = createTurnOutcomeStore();
    const result = { version: 3, private: true, turnId: 'product-user', status, text: 'Synthetic result', sources: [], citations: [], obligations: [], limitations: [], coverage: [], receipts: { modelCalls: 1, ioAttempts: 1, recovery: 'none', elapsedMs: 1 } };
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: result.text } }] })}\n\ndata: ${JSON.stringify({ meeting_result: result })}\n\ndata: [DONE]\n\n`)) as typeof fetch;
    const adapter = createChatModelAdapter({ ...deps(), turnOutcomes: outcomes } as never);
    for await (const _ of adapter.run({ messages: [{ id: 'product-user', role: 'user', content: [{ type: 'text', text: 'Summarize' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'product-answer' } as never)) {}
    expect(outcomes.get('thread', 'product-user')?.status).toBe(status);
    expect(outcomes.forMessage('thread', 'product-answer')?.result?.status).toBe(status);
  });
}

test('mixed checkpoint and private-result frames cannot write checkpoint facts', async () => {
  const { createTurnOutcomeStore } = await import('./pendingHandoff');
  const outcomes = createTurnOutcomeStore(); let checkpointWrites = 0;
  const result = { version: 3, private: true, turnId: 'mixed-user', status: 'completed', text: 'PRIVATE_CANARY', sources: [], citations: [], obligations: [], limitations: [], coverage: [], receipts: { modelCalls: 1, ioAttempts: 1, recovery: 'none', elapsedMs: 1 } };
  globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ compaction_checkpoint: { coversThroughMessageId: 'mixed-user', summary: 'PRIVATE_CANARY' } })}\n\ndata: ${JSON.stringify({ meeting_result: result })}\n\ndata: [DONE]\n\n`)) as typeof fetch;
  const adapter = createChatModelAdapter({ ...deps(), turnOutcomes: outcomes, appendCompaction: async () => { checkpointWrites++; return {}; } } as never);
  for await (const _ of adapter.run({ messages: [{ id: 'mixed-user', role: 'user', content: [{ type: 'text', text: 'Summarize' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'mixed-answer' } as never)) {}
  expect(checkpointWrites).toBe(0);
  expect(outcomes.get('thread', 'mixed-user')).toMatchObject({ status: 'failed', private: true });
});

test('a malformed terminal cannot become ordinary success or persist staged checkpoint facts', async () => {
  const { createTurnOutcomeStore } = await import('./pendingHandoff');
  const outcomes = createTurnOutcomeStore(); let checkpointWrites = 0;
  globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ compaction_checkpoint: { coversThroughMessageId: 'malformed-user', summary: 'PRIVATE_CANARY' } })}\n\ndata: {"meeting_result":\n\ndata: [DONE]\n\n`)) as typeof fetch;
  const adapter = createChatModelAdapter({ ...deps(), turnOutcomes: outcomes, appendCompaction: async () => { checkpointWrites++; return {}; } } as never);
  for await (const _ of adapter.run({ messages: [{ id: 'malformed-user', role: 'user', content: [{ type: 'text', text: 'Summarize' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'malformed-answer' } as never)) {}
  expect(checkpointWrites).toBe(0);
  expect(outcomes.get('thread', 'malformed-user')).toMatchObject({ status: 'failed', private: true });
});


test('pre-v3 checkpoint summaries are not supplied for backend fact promotion', async () => {
  let body: any;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('data: [DONE]\n\n'); }) as typeof fetch;
  const adapter = createChatModelAdapter({ ...deps(), getCheckpoint: async () => ({ id: 'legacy', threadId: 'thread', coversThroughMessageId: 'old', summary: 'PRIVATE_LEGACY_CANARY', createdAt: '' }) } as never);
  for await (const _ of adapter.run({ messages: [{ id: 'new-user', role: 'user', content: [{ type: 'text', text: 'Hi' }] }], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'new-answer' } as never)) {}
  expect(body.preparation.checkpoint).toBeNull();
  expect(JSON.stringify(body)).not.toContain('PRIVATE_LEGACY_CANARY');
});

test('displayed ordinal101 retains all200 frozen parent sources in the request', async () => {
  const sources = Array.from({length: 200}, (_, i) => ({ source: 'fireflies', sourceId: 'source-' + (i + 1), meetingRef: 'source-' + (i + 1), revision: 'a'.repeat(64) }));
  const prior = { turnId: 'prior-user', sentAt: 1, status: 'partial', private: true, result: { version: 3, private: true, turnId: 'prior-user', status: 'partial', sources, text: 'PRIVATE_OLD_LIST' } };
  let body: any;
  globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('data: [DONE]\n\n'); }) as typeof fetch;
  const adapter = createChatModelAdapter(deps() as never);
  for await (const _ of adapter.run({ messages: [
    { id: 'prior-answer', role: 'assistant', content: [{ type: 'text', text: 'PRIVATE_OLD_LIST' }], metadata: { custom: { turn: prior } } },
    { id: 'ordinal-user', role: 'user', content: [{ type: 'text', text: 'Summarize101' }], metadata: { custom: { meetingTurn: { intent: { mode: 'analysis', parts: [{id: 'summary', question: 'Summarize'}], ordinal: 101 } } } } },
  ], abortSignal: new AbortController().signal, context: {}, unstable_assistantMessageId: 'ordinal-answer' } as never)) {}
  expect(body.turn.parent.sources).toHaveLength(200);
  expect(body.turn.parent.sources[100]).toEqual(sources[100]);
  expect(body.turn.intent.ordinal).toBe(101);
  expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_OLD_LIST');
});
