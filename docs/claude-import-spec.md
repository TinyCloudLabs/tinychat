# Spec: Import Claude history into TinyChat

**Status:** Draft for review · **Scope:** Claude only (ChatGPT deferred) · **Date:** 2026-06-03

## 1. Goal

Let a signed-in user import their past Claude.ai conversations into TinyChat so
the threads appear in the sidebar and read back exactly like native chats. The
imported data lives in the user's own TinyCloud space (same per-space SQLite DB
as native threads) — nothing touches the backend.

### Decisions locked in
- **Source:** Claude export only. ChatGPT's `mapping`-tree walk is out of scope.
- **Selection UX:** Pick-list. User uploads the file, then checks which
  conversations to import (title + date + message count shown). No silent bulk dump.
- **Non-text content:** Text-placeholder. Attachments/files become an inline
  marker (`[attachment: resume.pdf]`) plus any `extracted_content` Claude stored.
  `thinking` and `tool_use`/`tool_result` blocks are dropped.

## 2. User flow

1. Signed in → click **Import** (new button, sidebar, under "New chat").
2. File picker accepts `.json` / `.jsonl` / `.zip`.
   - If `.zip`: extract `conversations.json` (or `.jsonl`) from it client-side.
3. Parse + normalize in the browser. Show a modal pick-list:
   `☑ Title · 12 messages · Mar 10, 2024`, with "select all".
   Conversations already present in the space (by id) are flagged "Already imported".
4. Click **Import N conversations** → sequential writes with a progress bar
   (`Importing 3 / 12…`).
5. On finish, refresh the sidebar. Imported threads sort by their **original**
   Claude date (not bumped to "now").

## 3. Architecture

Pure client-side. Three pieces:

| Piece | File | Responsibility |
|-------|------|----------------|
| Parser/normalizer | `frontend/src/lib/claudeImport.ts` *(new)* | File → `NormalizedConversation[]`. No TinyCloud deps; unit-testable. |
| Store writer | `frontend/src/lib/threadStore.ts` *(add `importThread`)* | Write one normalized conversation as a thread row + message rows. |
| UI | `frontend/src/chat/ImportDialog.tsx` *(new)* + button in `ThreadList.tsx` | File pick → preview list → drive import → refresh. |

No backend, manifest, or runtime-adapter changes. The signed-in session already
holds the `tinycloud.sql` capability used by `threadStore`.

## 4. Claude export format (what we parse)

A `.zip` (emailed link) containing `conversations.json` **or** `conversations.jsonl`.

```jsonc
{
  "uuid": "conv-uuid",
  "name": "Cover letter help",          // → title (fallback "Untitled")
  "created_at": "2024-03-10T14:30:00.000000+00:00",  // ISO 8601 (already)
  "updated_at": "2024-03-10T15:45:00.000000+00:00",
  "chat_messages": [                     // ALREADY LINEAR — no tree walk
    {
      "uuid": "msg-uuid",
      "sender": "human",                 // ⚠ "human" not "user"
      "text": "…",                       // fast path; may be "" for tool-only
      "created_at": "2024-03-10T14:30:01...",
      "content": [                        // fallback when text == ""
        { "type": "text", "text": "…" },
        { "type": "thinking", "thinking": "…" },     // DROP
        { "type": "tool_use", "name": "…", "input": {…} }, // DROP
        { "type": "tool_result", … }                 // DROP
      ],
      "attachments": [{ "file_name": "resume.pdf", "extracted_content": "…" }],
      "files": [ … ]
    }
  ]
}
```

### Parser rules (`claudeImport.ts`)
- Accept either a JSON array or JSONL (try `JSON.parse`; on failure, split lines
  and parse each). Accept a `.zip` and pull the conversations file out.
- Per conversation → `NormalizedConversation`:
  ```ts
  interface NormalizedConversation {
    sourceId: string;     // conv.uuid
    title: string;        // conv.name || "Untitled"
    createdAt: string;    // conv.created_at
    updatedAt: string;    // conv.updated_at || created_at
    messages: NormalizedMessage[];
  }
  interface NormalizedMessage {
    role: "user" | "assistant";   // human→user, assistant→assistant
    text: string;                 // see extraction below
    createdAt: string;
  }
  ```
- **Role map:** `human → user`, `assistant → assistant`. Anything else → skip.
- **Text extraction:** prefer top-level `text`; if empty, concat `content[]`
  blocks of `type === "text"`. Append attachment markers:
  `\n\n[attachment: <file_name>]` and, if present, the `extracted_content`.
  Skip `thinking` / `tool_use` / `tool_result`.
- **Drop empty messages** (no text after extraction) so we don't store blanks.
- Conversations with **0 usable messages are excluded** from the pick-list
  (they'd be skipped by `listThreads`-style empty filtering anyway).

## 5. Mapping to TinyChat storage

`threadStore` schema is fixed: `threads(id,title,model,created_at,updated_at)` +
`messages(thread_id,position,payload,created_at)`, payload = JSON of an
assistant-ui `ExportedMessageRepositoryItem`.

| Normalized field | TinyChat target |
|------------------|-----------------|
| `sourceId` | thread `id` = `claude-<uuid>` (stable → idempotent re-import) |
| `title` | thread `title` (passed explicitly — bypasses first-user-message derivation) |
| `createdAt`/`updatedAt` | thread `created_at`/`updated_at` (preserves sidebar sort order) |
| — | thread `model` = `phala/minimax-m2.5` (see §8) |
| each message | one `messages` row, `position` = index |

### Message payload shape (must satisfy assistant-ui's `MessageRepository.import`)
`runtime.tsx#load()` spreads each stored item and rebuilds `parentId`/`headId`,
so the importer only needs each item to carry a string `message.id`, a `role`,
and `content` parts:

```jsonc
{
  "message": {
    "id": "claude-<uuid>-<index>",       // unique within thread; load() drops items without it
    "role": "user",                       // or "assistant"
    "content": [{ "type": "text", "text": "…" }],
    "createdAt": "2024-03-10T14:30:01...", // include for fidelity
    "status": { "type": "complete", "reason": "stop" } // assistant only — VERIFY (see §10)
  }
}
```

## 6. `importThread()` (new in threadStore.ts)

```ts
export async function importThread(
  tcw: TinyCloudWeb,
  conv: { id: string; title: string; createdAt: string; updatedAt: string;
          model?: string; items: StoredMessageItem[] },
): Promise<void>
```

Behavior (single `batch` per conversation → one signed round-trip):
1. `ensureSchema(tcw)`; `mutationGen++`.
2. `DELETE FROM messages WHERE thread_id = ?` (idempotent re-import: clean replace).
3. Upsert `threads` row with the conversation's title/model/timestamps
   (`ON CONFLICT(id) DO UPDATE`).
4. Insert each item with explicit `position` (0..n) and `created_at`.
5. `patchCacheEntry` for the new summary.

After the whole batch of conversations, the dialog **clears the index cache** and
calls `listThreads` cold so the sidebar reflects every import at once.

## 7. UI

- **Button:** add next to `ThreadListPrimitive.New` in `ThreadList.tsx`
  (an `UploadIcon` "Import" button) that opens `ImportDialog`.
- **Dialog** (`ImportDialog.tsx`, reuse existing `AlertDialog`/shadcn primitives):
  file input → parsed pick-list with checkboxes + "select all" + per-row
  "Already imported" badge → progress bar → done summary
  ("Imported 8, skipped 2 already present").
- Needs `tcw` — thread through from `ChatWorkspace`/`App` like `MemoryPopover`.
- After success, trigger the sidebar refresh (cache clear + re-list).

## 8. Open decisions (defaults chosen, flag if you disagree)
- **Model for imported threads:** default to `phala/minimax-m2.5` so the user can
  *continue* the conversation through the RedPill proxy (a TEE-hosted `phala/*`
  model, consistent with TinyCloud's privacy posture). We do NOT try to honor the
  Claude export's original `model` — it is often `null` and its exact string
  (e.g. `claude-opus-4-5`) won't match a RedPill picker option. The user can
  still switch models per-thread after import via the existing picker.
- **Re-import = replace.** Same conversation re-imported overwrites its messages
  (delete-then-insert). *Alternative:* skip if exists.
- **`.zip` support:** include it (users get a zip from Claude). Adds a tiny unzip
  dep (e.g. `fflate`) unless we ask users to unzip first. *Alternative:* accept
  only the raw `.json`/`.jsonl` and document "unzip first" (zero deps).

## 9. Test plan
- **Unit (`claudeImport.test.ts`):** array vs JSONL parsing; `human→user`;
  empty-`text` → `content[]` fallback; attachment marker; thinking/tool blocks
  dropped; 0-message conversation excluded; missing `name` → "Untitled".
- **Store:** `importThread` inserts ordered rows; re-import replaces (no
  position-PK collision); timestamps preserved; appears in `listThreads`.
- **E2E (extend `test/real-auth-manual.ts`):** sign in → import a fixture export
  → assert N threads in sidebar → open one → assert messages + order render →
  reload → still present (round-trips through the user's space).
- **Fixture:** commit a small synthetic `test/fixtures/claude-export.json`
  (2–3 conversations incl. one with an attachment + one tool-only message).

## 10. Risks / things to verify before coding
- **`ExportedMessageRepositoryItem` exact shape.** Confirm the minimum fields
  `MessageRepository.import` requires (does the assistant `status` /
  `createdAt` need a specific form?). Build one item, round-trip it through
  `load()` in a scratch test before committing to the payload shape.
- **SQL latency × thread count.** Each conversation is one ~2s signed
  round-trip; importing 50 = ~100s. Sequential only (TinyCloud SQL drops
  concurrent responses — see memory note). Progress bar is mandatory; consider a
  soft cap / warning above ~50.
- **Batch size per conversation.** A very long chat = one big multi-statement
  batch; verify the SQL service accepts large batches (chunk if not).
- **Cache coherence.** Bulk import must not leave a partial `tinychat:index`
  cache — clear + cold re-list after the run.

## 11. Out of scope (v1)
ChatGPT imports · attachment binaries/images · `thinking`/tool blocks ·
preserving Claude branching · re-running imported chats automatically.
