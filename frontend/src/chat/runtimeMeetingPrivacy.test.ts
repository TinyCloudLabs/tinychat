import { beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTurnOutcomeStore, type TurnOutcome } from './pendingHandoff';
import { getThread } from '../lib/threadStore';
import type { MeetingResult } from '@tinyboilerplate/core';
let createHistoryAdapter: typeof import('./runtime').createHistoryAdapter;
let repositoryFromDoc: typeof import('./runtime').repositoryFromDoc;
beforeAll(async () => {
  (globalThis as any).HTMLElement ??= class {};
  (globalThis as any).customElements ??= { define() {}, get() {}, getName() {}, upgrade() {}, whenDefined: async () => {} };
  ({ createHistoryAdapter, repositoryFromDoc } = await import('./runtime'));
});
function fixture() {
  const db = new Database(':memory:');
  let loseAcknowledgement = false;
  const execute = async (sql: string, params: any[] = []) => { db.query(sql).run(...params); return { ok: true, data: { rows: [] } }; };
  const sql = {
    query: async (sql: string, params: any[] = []) => ({ ok: true, data: { rows: db.query(sql).values(...params) } }), execute,
    batch: async (statements: Array<{ sql: string; params?: any[] }>) => {
      db.transaction(() => { for (const statement of statements) db.query(statement.sql).run(...(statement.params ?? [])); })();
      if (loseAcknowledgement) { loseAcknowledgement = false; return { ok: false, error: { code: 'LOST_ACK', message: 'synthetic lost acknowledgment' } }; }
      return { ok: true, data: { rows: [] } };
    },
  };
  const tcw = { did: `did:synthetic:${crypto.randomUUID()}`, sql: { db: () => sql } } as any;
  const origin = { turnId: 'u', threadId: 't', tcw, model: 'z-ai/glm-5.3', signal: new AbortController().signal };
  const selection = { beginTurn: async (_threadId: string, turnId: string) => ({ ...origin, turnId }), assertActive() {}, confirmAppend() {}, isAppendSaved: () => true, needsFirstInsert: () => false } as any;
  return { tcw, selection, loseAck: () => { loseAcknowledgement = true; } };
}
function item(id: string, role: 'user' | 'assistant', text: string) {
  return { parentId: role === 'user' ? null : 'u', message: { id, role, content: [{ type: 'text', text }], createdAt: new Date('2026-09-14T00:00:00Z') } } as any;
}
function result(): MeetingResult {
  return {
    version: 3, turnId: 'u', private: true, status: 'partial', text: 'PRIVATE_TRANSCRIPT_CANARY',
    sources: ['C', 'A', 'B'].map(id => ({ source: 'fireflies', sourceId: id, meetingRef: id, revision: `sha256:${id}` })),
    citations: [], obligations: [], limitations: [], coverage: [],
    continuation: { version: 3, cursor: 'C', pending: [], encountered: [], examinedSources: 3, matchedSources: 3, exhausted: false, intent: { mode: 'search', parts: [{ id: 'p', question: 'literal' }], terms: ['literal'] } },
    receipts: { modelCalls: 1, ioAttempts: 3, recovery: 'none', elapsedMs: 4 },
  };
}
test('private result persists exactly once, survives reload and never enters factual memory', async () => {
  const { tcw, selection, loseAck } = fixture(); const outcomes = createTurnOutcomeStore(); let extraction = 0;
  const history = createHistoryAdapter(tcw, 't', selection, () => { extraction++; }, undefined, outcomes);
  await history.append(item('u', 'user', 'Summarize'));
  const terminal: TurnOutcome = { turnId: 'u', sentAt: 1, status: 'partial', private: true, result: result() };
  outcomes.claim('t', terminal);
  loseAck();
  await history.append(item('a', 'assistant', terminal.result!.text));
  await history.append(item('a', 'assistant', 'LATE_REPLACEMENT'));
  const doc = await getThread(tcw, 't');
  expect(doc!.messages).toHaveLength(2);
  expect(JSON.stringify(doc)).toContain('PRIVATE_TRANSCRIPT_CANARY');
  expect(JSON.stringify(doc)).not.toContain('LATE_REPLACEMENT');
  expect((doc!.messages[1] as any).turn.result.status).toBe('partial');
  const restored = createTurnOutcomeStore();
  repositoryFromDoc(doc!, restored);
  expect(restored.forMessage('t', 'a')?.result?.sources.map(source => source.sourceId)).toEqual(['C', 'A', 'B']);
  expect(restored.forMessage('t', 'a')?.result?.continuation?.cursor).toBe('C');
  expect(extraction).toBe(0);
});
test('a claimed cancellation persists instead of late content and suppresses memory', async () => {
  const { tcw, selection } = fixture(); const outcomes = createTurnOutcomeStore(); let extraction = 0;
  const history = createHistoryAdapter(tcw, 't', selection, () => { extraction++; }, undefined, outcomes);
  await history.append(item('u', 'user', 'Summarize'));
  outcomes.claim('t', { turnId: 'u', sentAt: 1, status: 'cancelled', private: true });
  expect(outcomes.claim('t', { turnId: 'u', sentAt: 1, status: 'partial', private: true, result: result() })).toBe(false);
  await history.append(item('a', 'assistant', 'LATE_ANSWER'));
  const doc = await getThread(tcw, 't');
  expect(JSON.stringify(doc)).not.toContain('LATE_ANSWER');
  expect((doc!.messages[1] as any).turn.status).toBe('cancelled');
  expect(extraction).toBe(0);
});
test('ordinary completed answers retain one factual-memory extraction after saved append', async () => {
  const { tcw, selection } = fixture(); const outcomes = createTurnOutcomeStore(); const exchanges: any[] = [];
  const history = createHistoryAdapter(tcw, 't', selection, exchange => { exchanges.push(exchange); }, undefined, outcomes);
  await history.append(item('u', 'user', 'My favorite color is blue'));
  outcomes.claim('t', { turnId: 'u', sentAt: 1, status: 'completed', private: false });
  await history.append(item('a', 'assistant', 'I will remember blue'));
  await history.append(item('a', 'assistant', 'I will remember blue'));
  expect(exchanges).toHaveLength(1);
  expect(exchanges[0]).toEqual([{ role: 'user', content: 'My favorite color is blue' }, { role: 'assistant', content: 'I will remember blue' }]);
});

test('retrying an old assistant append after another Send cannot steal the new turn origin', async () => {
  const { tcw, selection } = fixture(); const outcomes = createTurnOutcomeStore(); const exchanges: any[] = [];
  const history = createHistoryAdapter(tcw, 't', selection, (exchange, turn) => { exchanges.push({ exchange, turn }); }, undefined, outcomes);
  await history.append(item('u', 'user', 'first user'));
  outcomes.claim('t', { turnId: 'u', sentAt: 1, status: 'completed', private: false });
  await history.append(item('a', 'assistant', 'first answer'));
  await history.append(item('u2', 'user', 'second user'));
  outcomes.claim('t', { turnId: 'u2', sentAt: 2, status: 'completed', private: false });
  await history.append(item('a', 'assistant', 'first answer'));
  await history.append(item('a2', 'assistant', 'second answer'));
  expect(exchanges).toHaveLength(2);
  expect(exchanges[1].exchange).toEqual([{ role: 'user', content: 'second user' }, { role: 'assistant', content: 'second answer' }]);
});
