import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAdmittedMeetingProvider, loadMeetingTokenizer, renderMeetingProviderPrompt, MEETING_TOKENIZER_FILES } from '../transcripts/meeting-provider.js';

const temporary: string[] = [];
async function folder() { const path = await mkdtemp(join(tmpdir(), 'meeting-tokenizer-')); temporary.push(path); return path; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const messages = (user: string, system = 'Use only evidence.') => [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }];

test('the restricted low-effort chat template preserves exact content and framing', () => {
  expect(renderMeetingProviderPrompt(messages(' \n雪_29\t', ' system\n'))).toBe('[gMASK]<sop><|system|>Reasoning Effort: Low<|system|> system\n<|user|> \n雪_29\t<|assistant|><think>');
});

test('the counter cannot silently accept unsupported history, tools, multimodal or reasoning messages', () => {
  for (const input of [[], [messages('x')[0]], [...messages('x'), { role: 'assistant', content: 'old' }], [...messages('x')].reverse(), [{ role: 'system', content: 'x' }, { role: 'user', content: [{ type: 'text', text: 'x' }] }], [{ ...messages('x')[0], tool_calls: [] }, messages('x')[1]], [{ ...messages('x')[0], reasoning_content: 'x' }, messages('x')[1]]]) {
    expect(() => renderMeetingProviderPrompt(input as never)).toThrow('meeting_provider_message_shape');
  }
});

test('missing or modified tokenizer artifacts fail before constructing a counter', async () => {
  const path = await folder();
  await expect(loadMeetingTokenizer(path)).rejects.toThrow('meeting_tokenizer_missing:tokenizer.json');
  await writeFile(join(path, MEETING_TOKENIZER_FILES[0].name), '{}');
  await expect(loadMeetingTokenizer(path)).rejects.toThrow('meeting_tokenizer_integrity:tokenizer.json');
});

test('admission is absent by default and a self-asserted receipt cannot enable it', async () => {
  expect(await loadAdmittedMeetingProvider()).toBeUndefined();
  await expect(loadAdmittedMeetingProvider('/some/path')).rejects.toThrow('meeting_provider_configuration_incomplete');
  const path = await folder();
  const receipt = join(path, 'gate.json');
  await writeFile(receipt, JSON.stringify({ admitted: true, model: 'z-ai/glm-5.3', gatewayAttemptsVerified: true, tokenizerExact: true }));
  await expect(loadAdmittedMeetingProvider(path, receipt)).rejects.toThrow('meeting_provider_gate_unverified');
});

// These conformance checks use the exact public artifacts, installed explicitly by
// the module's CLI. Unit tests above always run without network or a large fixture.
const tokenizerDirectory = process.env.MEETING_TOKENIZER_DIR;
describe.skipIf(!tokenizerDirectory)('pinned tokenizer / retained live provider conformance', () => {
  test('ASCII, escaped Unicode and near-budget complete payload counts equal provider usage', async () => {
    const counter = await loadMeetingTokenizer(tokenizerDirectory!);
    const system = 'Return one JSON object with the requested markers, copied only from the synthetic evidence. No explanation.';
    const payloads = [
      { evidence: { question: 'Return marker.', id: 'synthetic:A', revision: 'sha256:a', body: 'Nia chose marker PINE_47.', output: { marker: 'PINE_47' } }, expected: 70 },
      { evidence: { question: 'Return markers in source order.', id: 'synthetic:réunion/雪/"A"', revision: 'sha256:b', body: 'Inês: decisão MARÉ_17. 李明: 决定 雪_29. Nia: marker PINE_47.', output: { markers: ['MARÉ_17', '雪_29', 'PINE_47'] } }, expected: 110 },
      { evidence: { question: 'Return markers in source order.', id: 'synthetic:large', revision: 'sha256:c', body: 'START marker CEDAR_11.\n' + 'Synthetic filler record; no task facts.\n'.repeat(1189) + 'MIDDLE marker BIRCH_23.\n' + 'Synthetic filler record; no task facts.\n'.repeat(1189) + 'END marker PINE_47.', output: { markers: ['CEDAR_11', 'BIRCH_23', 'PINE_47'] } }, expected: 23883 },
    ];
    for (const { evidence, expected } of payloads) expect(counter.countInputTokens(messages(JSON.stringify(evidence), system))).toBe(expected);
    expect(counter.contextTokens).toBe(1048576);
    expect(counter.model).toBe('z-ai/glm-5.3');
  });
});
