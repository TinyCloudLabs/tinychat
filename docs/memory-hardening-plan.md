# TinyChat Memory Hardening Plan (Layers 1–3)

## Goal

Make the per-space user memory **impossible to silently lose**, even if the chat
model is unpinned and the model picker / catalog churns again. This is a
defensive hardening of the existing memory feature — **no new feature, no
backend change, no manifest/capability change**.

## Background — how memory got erased before

Memory is **one doc per user**, identity-scoped (`tcw.did ?? tcw.spaceId`),
stored as a **single row** in the per-space SQLite DB:

- DB handle: `xyz.tinycloud.tinychat/threads` (`threadStore.ts` `SQL_DB_NAME`)
- table `memory`, single row `id = 'user_context'`

After each assistant turn, `runExtraction` (`frontend/src/lib/memory.ts`) asks a
model to "return the **FULL updated document**", then `setMemory` performs a
**blind UPSERT** of that whole row (`threadStore.ts:350`). The only guards are
"non-empty" and "differs from current" (`memory.ts:283-291`).

Two failure modes resulted from coupling the extractor to the model lineup
(`MEMORY_EXTRACTION_MODEL` in `runtime.tsx` rode every picker swap:
`gpt-5-mini → gpt-oss-20b → qwen-2.5-7b (wrong prefix) → deepseek-v4-pro`):

1. **Silent stop.** When `MEMORY_EXTRACTION_MODEL` pointed at an unoffered /
   wrong-prefixed id, the extraction POST returned `403 model_not_offered` and
   memory silently never updated.
2. **Clobber.** When extraction ran on a weak model that ignored the "return the
   full doc" contract (returned just new facts / a summary / a truncated doc),
   the blind UPSERT overwrote the accumulated doc with a thin one. There is **no
   regression guard** today.

There is also **no recoverability** — single overwriteable row, no history.

## The three layers (defense in depth)

Each layer defends one of the independent things that must hold for memory to
survive. They are additive and all in the frontend.

---

### Layer 1 — Resilient extractor selection (kills the silent-stop)

**File:** `frontend/src/chat/runtime.tsx`

Today the extraction call hardcodes `model: MEMORY_EXTRACTION_MODEL`
(`runtime.tsx:377`). A hardcoded id can drift out of the offered set →
silent 403. Replace it with a runtime pick from the **offered set**, which
already exists as `deps.offeredModelIdsRef`.

Add a helper:

```ts
/** Choose an extraction model that is guaranteed to be offered, so the
 *  extraction POST can never 403 with model_not_offered (silent memory stop).
 *  Preference order: configured preferred → current chat model → first offered. */
function pickExtractionModel(d: ChatRuntimeDeps): string {
  const offered = d.offeredModelIdsRef.current;
  // Catalog not loaded yet — best effort with the preferred id.
  if (!offered || offered.size === 0) return MEMORY_EXTRACTION_MODEL;
  if (offered.has(MEMORY_EXTRACTION_MODEL)) return MEMORY_EXTRACTION_MODEL;
  const chat = d.modelRef.current;
  if (chat && offered.has(chat)) {
    console.warn(
      `[memory] extraction model ${MEMORY_EXTRACTION_MODEL} not offered; ` +
        `falling back to current chat model ${chat}`,
    );
    return chat;
  }
  const first = offered.values().next().value as string | undefined;
  console.warn(
    `[memory] extraction model ${MEMORY_EXTRACTION_MODEL} not offered and chat ` +
      `model unavailable; falling back to ${first ?? MEMORY_EXTRACTION_MODEL}`,
  );
  return first ?? MEMORY_EXTRACTION_MODEL;
}
```

Wire it at the extraction call site (replace the hardcoded `model:`):

```ts
complete: (messages, opts) =>
  completeChat({
    backendUrl: d.backendUrl,
    sessionStore: d.sessionStore,
    model: pickExtractionModel(d),
    messages,
    maxTokens: MEMORY_EXTRACTION_MAX_TOKENS,
    abortSignal: opts?.abortSignal,
  }),
```

Add a **one-shot boot warning** (effect that runs when the offered catalog first
loads): if `MEMORY_EXTRACTION_MODEL ∉ offered`, `console.warn` loudly so the
drift is visible in dev instead of failing silently. Keep it to a single warn
(guard with a ref so it doesn't spam every render).

Update the `MEMORY_EXTRACTION_MODEL` doc comment to describe the fallback (it is
now the *preferred* id, not the only one).

---

### Layer 2 — Regression guard (rejects a destructive write)

**File:** `frontend/src/lib/memory.ts` (pure, unit-testable)

Add an exported pure function that decides whether a model-produced doc is a
safe replacement for the prior one:

```ts
/** Minimum prior-doc length (chars) before the shrink check applies — below
 *  this the doc is still bootstrapping and large relative shrink is normal. */
const GUARD_MIN_PRIOR_CHARS = 200;
/** Reject a write that drops below this fraction of the prior doc length. */
const GUARD_SHRINK_FLOOR = 0.6;

export interface MemoryWriteAssessment { ok: boolean; reason?: string; }

/** Pure: decide whether `next` is a safe replacement for `prev`. Used by
 *  runExtraction ONLY (model-produced writes). User edits via the panel are
 *  authoritative and bypass this. */
export function assessMemoryWrite(
  prev: string | null | undefined,
  next: string,
): MemoryWriteAssessment {
  if (!hasContent(next)) return { ok: false, reason: "empty" };
  // A well-formed doc always carries the top-level header; its absence means
  // the model truncated or returned garbage.
  if (!next.includes(DOC_HEADER)) return { ok: false, reason: "missing-header" };

  if (!hasContent(prev)) return { ok: true };
  const prevTrim = prev.trim();
  const nextTrim = next.trim();

  // Section-drop: every "## " section that existed in prev must still exist.
  const prevSections = prevTrim
    .split("\n")
    .filter((l) => l.startsWith("## "))
    .map((l) => l.trim());
  for (const h of prevSections) {
    if (!nextTrim.includes(h)) return { ok: false, reason: `section-dropped:${h}` };
  }

  // Shrink: a substantial prior doc must not collapse past the floor.
  if (
    prevTrim.length >= GUARD_MIN_PRIOR_CHARS &&
    nextTrim.length < prevTrim.length * GUARD_SHRINK_FLOOR
  ) {
    return { ok: false, reason: "shrink" };
  }
  return { ok: true };
}
```

Wire into `runExtraction` (`memory.ts`), **after** the existing
empty/unchanged/writeGen guards and **before** `deps.setDoc(next)`:

```ts
const assessment = assessMemoryWrite(currentDoc, next);
if (!assessment.ok) {
  console.warn(`[memory] rejected regressive extraction (${assessment.reason})`);
  return; // keep the prior doc; never overwrite with a regression
}
await deps.setDoc(next);
```

**Scope note (must hold):** the guard lives in `runExtraction` only. The
`MemoryPanel` save/clear path writes through `setMemory`/`clearMemory` directly
and is authoritative — the user may legitimately delete sections.

---

### Layer 3 — Last-known-good backup + auto-restore (recoverability)

**File:** `frontend/src/lib/threadStore.ts`

Keep a second row in the **same `memory` table** (no schema change, no
CREATE INDEX) holding the previous good doc, and auto-restore from it if the live
row is ever found empty.

```ts
/** Stable id of the backup (last-known-good) memory row. */
const MEMORY_BACKUP_ROW_ID = "user_context_backup";
```

**`setMemory`** — snapshot the prior live doc into the backup row, then write the
new one, in a single batch (one extra read):

```ts
export async function setMemory(tcw: TinyCloudWeb, content: string): Promise<void> {
  _memoryWriteGen++;
  await ensureSchema(tcw);
  const now = new Date().toISOString();
  const UPSERT =
    `INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`;

  // Snapshot the prior live doc as last-known-good (best effort).
  const prior = await store(tcw).query("SELECT content FROM memory WHERE id = ?", [MEMORY_ROW_ID]);
  const stmts: { sql: string; params: (string)[] }[] = [];
  if (prior.ok && prior.data.rows.length > 0) {
    const priorContent = cellStr(prior.data.rows[0], 0, "");
    if (priorContent.trim().length > 0) {
      stmts.push({ sql: UPSERT, params: [MEMORY_BACKUP_ROW_ID, priorContent, now] });
    }
  }
  stmts.push({ sql: UPSERT, params: [MEMORY_ROW_ID, content, now] });

  const res = await store(tcw).batch(stmts);
  if (!res.ok) throw new SqlOpError(res.error, "setMemory");
  writeMemoryCache(tcw, content);
}
```

**`getMemory`** — if the live row is missing or empty, fall back to the backup
row and restore it:

```ts
// inside the try, after reading the live row:
const rows = res.data.rows;
const liveContent = rows.length > 0 ? cellStr(rows[0], 0, "") : "";
if (liveContent.trim().length > 0) {
  writeMemoryCache(tcw, liveContent);
  return liveContent;
}
// Live empty/missing — try last-known-good backup and restore it.
const bk = await store(tcw).query("SELECT content FROM memory WHERE id = ?", [MEMORY_BACKUP_ROW_ID]);
if (bk.ok && bk.data.rows.length > 0) {
  const bkContent = cellStr(bk.data.rows[0], 0, "");
  if (bkContent.trim().length > 0) {
    const now = new Date().toISOString();
    await store(tcw).execute(
      `INSERT INTO memory (id, content, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      [MEMORY_ROW_ID, bkContent, now],
    );
    writeMemoryCache(tcw, bkContent);
    return bkContent;
  }
}
return null;
```

**`clearMemory`** — delete BOTH rows so an explicit user "Clear" is not
resurrected by auto-restore:

```ts
const res = await store(tcw).batch([
  { sql: "DELETE FROM memory WHERE id = ?", params: [MEMORY_ROW_ID] },
  { sql: "DELETE FROM memory WHERE id = ?", params: [MEMORY_BACKUP_ROW_ID] },
]);
```

Keep all ops Result-based (never throw into the chat path); AUTH_UNAUTHORIZED →
localStorage cache fallback stays exactly as today.

---

## Tests (acceptance for Layers 1–3)

**File:** `frontend/src/lib/memory.test.ts` — ADD `assessMemoryWrite` cases
(these run under `bun test frontend/src/lib/memory.test.ts`, which the workflow's
`memory-test.mjs` already globs):

- empty `next` → `{ ok: false, reason: "empty" }`
- `next` without `# About the user` → `{ ok: false, reason: "missing-header" }`
- a `## ` section present in `prev` but missing in `next` → `ok: false`
  (`section-dropped:*`)
- substantial `prev` (≥200 chars) collapsing below 60% → `{ ok:false, reason:"shrink" }`
- legit additive update (grows, keeps all sections) → `ok: true`
- `prev = null` + valid first doc (has header) → `ok: true`
- `prev = null` + malformed first doc (no header) → `ok: false`

The `threadStore.ts` backup/restore is SQL-bound (not pure) — it is covered by
the code audit + the deterministic regression build, not by these unit tests.

## Non-negotiables

- **No backend, route, or manifest/capability changes.** Same DB handle
  `xyz.tinycloud.tinychat/threads`, same `memory` table, **no CREATE INDEX**.
- Memory stays **space/identity-scoped** (`did ?? spaceId`) — no cross-space
  reads/writes.
- Extraction stays **fire-and-forget** and never blocks the SSE/chat path; every
  failure is logged and the prior doc is kept.
- The regression guard applies to **model-produced writes only** (runExtraction),
  never to user panel edits.
- **Backward compatible:** existing single-row docs keep working; the backup row
  is created lazily on the next write.
- Do not change the MemoryPanel UX or the system-prompt injection format.

## Verification (run until green)

```bash
cd /Users/roman/Documents/GitHub/tinychat
bun --bun run build:frontend          # tsc + vite build (typecheck + prod build)
bun test frontend/src/lib/memory.test.ts
bun run lint
```
