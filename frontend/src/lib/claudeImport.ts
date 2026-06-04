import type { ExportedMessageRepositoryItem } from "@assistant-ui/react";
import { unzipSync, strFromU8 } from "fflate";

import type { StoredMessageItem } from "./threadStore";

// ── Spec §4 normalized shape ─────────────────────────────────────────
//
// `parseClaudeExport` is the single entry point the ImportDialog uses to
// turn whatever the user uploaded (raw JSON, JSONL, a Claude email zip, or
// an already-parsed value) into the same flat list of conversations the
// downstream code consumes. Everything Claude-specific stops here.

export interface NormalizedMessage {
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface NormalizedConversation {
  sourceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: NormalizedMessage[];
}

export interface ConversationSummary {
  sourceId: string;
  title: string;
  createdAt: string;
  messageCount: number;
}

/**
 * Inputs the import dialog might hand us:
 *   • `string` — a `conversations.json` array or `.jsonl` line stream
 *   • bytes   — a `.zip` (we look inside) or raw UTF-8 if not a zip
 *   • array   — a pre-parsed list of conversation objects (tests, callers
 *     that already JSON.parse'd themselves)
 */
export type ClaudeExportInput =
  | string
  | Uint8Array
  | ArrayBuffer
  | readonly unknown[];

/**
 * Parse + normalize a Claude.ai export. Never throws on unknown content
 * blocks — they're silently dropped per spec §4. Returns conversations
 * with at least one usable message; zero-message conversations are
 * excluded.
 */
export async function parseClaudeExport(
  input: ClaudeExportInput,
): Promise<NormalizedConversation[]> {
  const raw = await loadRawConversations(input);
  const out: NormalizedConversation[] = [];
  for (const conv of raw) {
    const norm = normalizeConversation(conv);
    if (norm && norm.messages.length > 0) out.push(norm);
  }
  return out;
}

/**
 * Pick-list rows for the ImportDialog: one entry per usable conversation,
 * sorted newest-first by createdAt. The export file's order is not guaranteed
 * (Claude's .json is usually newest-first, but .jsonl / reordered exports are
 * not), so we sort explicitly to mirror the sidebar (threads by updated_at DESC).
 */
export function summarizeConversations(
  convs: readonly NormalizedConversation[],
): ConversationSummary[] {
  return convs
    .map((c) => ({
      sourceId: c.sourceId,
      title: c.title,
      createdAt: c.createdAt,
      messageCount: c.messages.length,
    }))
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1; // undated rows sink to the bottom
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
}

// ── Input decoding ───────────────────────────────────────────────────

async function loadRawConversations(
  input: ClaudeExportInput,
): Promise<unknown[]> {
  if (Array.isArray(input)) return [...input];

  if (typeof input === "string") return parseTextPayload(input);

  // Bytes: zip first (magic = "PK\x03\x04"), otherwise decode as UTF-8.
  const bytes =
    input instanceof Uint8Array ? input : new Uint8Array(input as ArrayBuffer);
  if (looksLikeZip(bytes)) {
    const text = extractConversationsFromZip(bytes);
    return parseTextPayload(text);
  }
  return parseTextPayload(strFromU8(bytes));
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function extractConversationsFromZip(bytes: Uint8Array): string {
  const entries = unzipSync(bytes);
  // Match the well-known names regardless of where they sit in the zip.
  const names = Object.keys(entries);
  const json = names.find((n) => /(^|\/)conversations\.json$/i.test(n));
  const jsonl = names.find((n) => /(^|\/)conversations\.jsonl$/i.test(n));
  const pick = json ?? jsonl;
  if (!pick) {
    throw new Error(
      "Zip does not contain conversations.json or conversations.jsonl",
    );
  }
  return strFromU8(entries[pick]);
}

function parseTextPayload(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Try array first; on parse failure (or non-array result), fall back to JSONL.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    // A single conversation object pasted as JSON: wrap it so the caller still
    // sees a list. Real Claude exports are always arrays/JSONL, but a hand-
    // copied conversation otherwise falls into the silent JSONL-parse-failure
    // path and yields an empty list.
    if (isObject(parsed) && Array.isArray(parsed.chat_messages)) {
      return [parsed];
    }
  } catch {
    // Fall through to JSONL handling.
  }
  return parseJsonl(trimmed);
}

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Skip malformed lines — never throw on bad input.
    }
  }
  return out;
}

// ── Conversation / message normalization ────────────────────────────

function normalizeConversation(raw: unknown): NormalizedConversation | null {
  if (!isObject(raw)) return null;
  const sourceId = pickString(raw.uuid) ?? pickString(raw.id);
  if (!sourceId) return null;

  const createdAt = pickString(raw.created_at) ?? "";
  const updatedAt = pickString(raw.updated_at) ?? createdAt;
  const title = pickString(raw.name) || "Untitled";

  const chat = Array.isArray(raw.chat_messages) ? raw.chat_messages : [];
  const messages: NormalizedMessage[] = [];
  for (const m of chat) {
    const norm = normalizeMessage(m);
    if (norm) messages.push(norm);
  }
  return { sourceId, title, createdAt, updatedAt, messages };
}

function normalizeMessage(raw: unknown): NormalizedMessage | null {
  if (!isObject(raw)) return null;
  const role = mapRole(raw.sender);
  if (!role) return null;

  const text = extractText(raw);
  if (!text) return null;

  const createdAt = pickString(raw.created_at) ?? "";
  return { role, text, createdAt };
}

function mapRole(sender: unknown): "user" | "assistant" | null {
  if (sender === "human") return "user";
  if (sender === "assistant") return "assistant";
  return null;
}

function extractText(msg: Record<string, unknown>): string {
  const parts: string[] = [];

  // Whitespace-only top text counts as empty so a tool-only message with
  // text=" " still walks the content[] fallback for any real text blocks.
  const topText = pickString(msg.text)?.trim() ?? "";
  if (topText.length > 0) {
    parts.push(topText);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (!isObject(block)) continue;
      // Drop thinking / tool_use / tool_result / anything we don't recognize.
      if (block.type !== "text") continue;
      const t = pickString(block.text);
      if (t) parts.push(t);
    }
  }

  appendAttachmentMarkers(parts, msg.attachments);
  appendAttachmentMarkers(parts, msg.files);

  return parts.join("").trim();
}

function appendAttachmentMarkers(parts: string[], list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (!isObject(item)) continue;
    const name = pickString(item.file_name) ?? pickString(item.name);
    if (!name) continue;
    let marker = `\n\n[attachment: ${name}]`;
    const extracted = pickString(item.extracted_content);
    if (extracted) marker += `\n${extracted}`;
    parts.push(marker);
  }
}

// ── Tiny type guards ────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ── Spec §10 risk probe: confirmed `ExportedMessageRepositoryItem` shape ──
//
// assistant-ui's `MessageRepository.import` only requires `message.id` to be a
// string; nothing else is validated at import time. Per the round-trip test
// next to this file, all of the following round-trip cleanly through
//   JSON.stringify -> JSON.parse -> runtime.tsx#load()-style reconstruction
//   -> MessageRepository.import:
//
//   • `parentId` is reconstructed by runtime.tsx#load() from row order — we do
//     not need to persist it. We always emit `parentId: null` on the item; the
//     reconstruction overrides it.
//   • `message.id` MUST be a string and unique within the thread — load() drops
//     items without it. We compose `<threadId>-<index>` so a re-import of the
//     same conversation overwrites in place.
//   • `message.role` is "user" or "assistant" — system messages are not used by
//     the importer.
//   • `message.content` is an array of `{type:"text",text:string}` parts. We do
//     not emit reasoning/tool parts (they're dropped during normalization).
//   • `message.createdAt` is emitted as an ISO string (Claude's original
//     timestamp). The type declares `Date`, but `appendMessage` already JSON-
//     serializes through SQLite for native chats, so the round-tripped form
//     downstream code observes is a string. We cast through `unknown` here so
//     the StoredMessageItem type stays honest.
//   • Assistant items carry `status: {type:"complete", reason:"stop"}` — the
//     repository does not check it, but auto-status / branch-picker reads do,
//     and `ThreadAssistantMessage` requires it. Omitting it leaves the UI in a
//     "running" state for the last imported turn.
//   • `metadata.custom: {}` is the minimum metadata shape both message variants
//     require to satisfy the type; the repository tolerates a missing
//     `metadata` at runtime but we always emit one for forward-compat.
//
// Anything beyond the fields above (e.g. attachments, unstable_state) is left
// at the minimum required by the type so a future schema change here is small.

/**
 * Stable message id used for the parent-chain reconstruction in
 * `runtime.tsx#load()`. Pair a thread id (e.g. `claude-<uuid>`) with the
 * message's 0-based index in the conversation so re-imports collide in place.
 */
export function claudeMessageId(threadId: string, index: number): string {
  return `${threadId}-${index}`;
}

/**
 * Build one stored history item from a normalized Claude message. The item is
 * persisted verbatim by `appendMessage` / the upcoming `importThread`, and
 * read back through the same JSON round-trip the runtime already exercises
 * for native chats.
 *
 * `threadId` is the eventual thread row id; with `index` it yields a stable
 * unique `message.id`. `createdAt` should be the original ISO timestamp from
 * the Claude export so the loaded message preserves its history.
 */
export function toStoredItem(
  role: "user" | "assistant",
  text: string,
  createdAt: string,
  index: number,
  threadId: string,
): StoredMessageItem {
  const id = claudeMessageId(threadId, index);
  const content = [{ type: "text" as const, text }];
  // ThreadMessage declares createdAt as Date; we persist ISO strings to match
  // the existing JSON round-trip the SQL store performs on native chats.
  const createdAtForType = createdAt as unknown as Date;

  const message =
    role === "user"
      ? {
          id,
          role: "user" as const,
          content,
          createdAt: createdAtForType,
          attachments: [],
          metadata: { custom: {} },
        }
      : {
          id,
          role: "assistant" as const,
          content,
          createdAt: createdAtForType,
          status: { type: "complete" as const, reason: "stop" as const },
          metadata: {
            unstable_state: null,
            unstable_annotations: [],
            unstable_data: [],
            steps: [],
            custom: {},
          },
        };

  return {
    message: message as ExportedMessageRepositoryItem["message"],
    parentId: null,
  };
}
