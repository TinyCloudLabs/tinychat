import { Tokenizer } from '@huggingface/tokenizers';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatMsg } from '../routes/agent-chat.js';
import type { MeetingProviderAdmission } from './meeting-turn.js';

export const MEETING_PROVIDER_MODEL = 'z-ai/glm-5.3' as const;
export const MEETING_TOKENIZER_REVISION = 'aca966e4e02791568aa6a4ced368624b3d897f42';
export const MEETING_TOKENIZER_FILES = [
  { name: 'tokenizer.json', bytes: 20217442, sha256: '19e773648cb4e65de8660ea6365e10acca112d42a854923df93db4a6f333a82d' },
  { name: 'tokenizer_config.json', bytes: 761, sha256: '98b1271574f41abf89427ae2dda030d94dc9478f0edc5a8bd240db213c6fd5fc' },
  { name: 'chat_template.jinja', bytes: 10734, sha256: '3740abcea51c45830cb3ca562084ad5fb2ef53589376f73332e9886f93ade41c' },
] as const;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The pinned HF template restricted to exactly the no-tools, Low-effort wire shape. */
export function renderMeetingProviderPrompt(messages: readonly ChatMsg[]): string {
  if (!Array.isArray(messages) || messages.length !== 2 || messages[0]?.role !== 'system' || messages[1]?.role !== 'user' ||
      messages.some(message => typeof message.content !== 'string' || Object.keys(message).some(key => key !== 'role' && key !== 'content'))) {
    throw new Error('meeting_provider_message_shape');
  }
  return '[gMASK]<sop><|system|>Reasoning Effort: Low<|system|>' + messages[0]!.content +
    '<|user|>' + messages[1]!.content + '<|assistant|><think>';
}

function verifyArtifact(file: typeof MEETING_TOKENIZER_FILES[number], bytes: Uint8Array): void {
  if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) throw new Error(`meeting_tokenizer_integrity:${file.name}`);
}

/** Read verified local assets once; token counting performs no I/O and no estimation. */
export async function loadMeetingTokenizer(directory: string) {
  const contents = new Map<string, Buffer>();
  for (const file of MEETING_TOKENIZER_FILES) {
    let bytes: Buffer;
    try { bytes = await readFile(join(directory, file.name)); }
    catch { throw new Error(`meeting_tokenizer_missing:${file.name}`); }
    verifyArtifact(file, bytes);
    contents.set(file.name, bytes);
  }
  const tokenizer = new Tokenizer(JSON.parse(contents.get('tokenizer.json')!.toString('utf8')), JSON.parse(contents.get('tokenizer_config.json')!.toString('utf8')));
  return Object.freeze({
    model: MEETING_PROVIDER_MODEL,
    contextTokens: 1048576,
    countInputTokens(messages: ChatMsg[]): number {
      return tokenizer.encode(renderMeetingProviderPrompt(messages), { add_special_tokens: false }).ids.length;
    },
  });
}

// Only a reviewed retained gate receipt may be added here in a code change. Its
// evidence must verify gateway/upstream attempt limits for these exact options,
// tokenizer conformance, framing/finish, deadlines and cancellation observations.
// Direct-HTTP success is not gateway-attempt proof. No receipt is admitted yet.
// Keeping this source-owned prevents an environment boolean or arbitrary JSON
// assertion from turning the provider on before that external gate is passed.
const REVIEWED_GATE_RECEIPTS: ReadonlySet<string> = new Set();

export async function loadAdmittedMeetingProvider(directory?: string, receiptPath?: string): Promise<MeetingProviderAdmission | undefined> {
  if (!directory && !receiptPath) return undefined;
  if (!directory || !receiptPath) throw new Error('meeting_provider_configuration_incomplete');
  let receipt: Buffer;
  try { receipt = await readFile(receiptPath); }
  catch { throw new Error('meeting_provider_gate_receipt_missing'); }
  if (!REVIEWED_GATE_RECEIPTS.has(sha256(receipt))) throw new Error('meeting_provider_gate_unverified');
  const tokenizer = await loadMeetingTokenizer(directory);
  return Object.freeze({ ...tokenizer, admitted: true as const });
}

/** Explicit installation only. Each pinned public artifact gets one HTTP attempt. */
export async function installMeetingTokenizer(directory: string): Promise<void> {
  const artifacts: Array<{ name: string; bytes: Buffer }> = [];
  for (const file of MEETING_TOKENIZER_FILES) {
    const response = await fetch(`https://huggingface.co/zai-org/GLM-5.3/resolve/${MEETING_TOKENIZER_REVISION}/${file.name}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok || !response.body) throw new Error(`meeting_tokenizer_download:${file.name}:${response.status}`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > file.bytes) throw new Error(`meeting_tokenizer_integrity:${file.name}`);
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    verifyArtifact(file, bytes);
    artifacts.push({ name: file.name, bytes });
  }
  await mkdir(directory, { recursive: true });
  for (const { name, bytes } of artifacts) {
    const temporary = join(directory, `${name}.${crypto.randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, join(directory, name)); }
    finally { await rm(temporary, { force: true }); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== 'install' || !process.argv[3] || process.argv.length !== 4) throw new Error('Usage: bun backend/src/transcripts/meeting-provider.ts install <directory>');
  await installMeetingTokenizer(process.argv[3]);
}
