# Building Persistent, Contextual Memory for TinyChat: A Research Report

*How leading AI products and OSS frameworks implement "the assistant knows about me," and what that means for a Bun/React/TinyCloud chat app.*

---

## 1. Executive Summary

- **Two dominant paradigms exist, and they are complementary, not rival.** (a) **Curated profile / file memory**: a small, human-readable, user-editable document (or a list of discrete facts) that is *injected wholesale* into the prompt every turn. (b) **RAG-over-history**: embed past turns/facts into a vector (or graph) store and *retrieve* a relevant subset per query. Production systems increasingly run both: a stable profile for durable identity/preferences plus retrieval for the long tail.
- **The big surprise: the three most-used consumer products mostly avoid RAG for memory.** ChatGPT's "reference chat history," Claude's consumer "Memory," and **Google Gemini's `user_context`** all lean on *periodically regenerated summaries + an editable profile injected into context*, not per-query vector search. The bet: context windows grow, costs fall, and strong models tolerate some irrelevant context — so "inject everything relevant" beats the recall failures and infra cost of semantic retrieval *at single-user scale*. Gemini is the strongest single confirmation of this thesis: its entire memory is one injected document, not retrieval.
- **A convergent five-stage pipeline underlies essentially every serious system:** `EXTRACT` salient facts (LLM-judged, almost always **asynchronously / off the hot path**) → `STORE` (profile doc + KV/vector facts, optionally a temporal graph) → `RETRIEVE` (hybrid score = relevance + recency + importance) → `INJECT` (system prompt block, or a `search_memory` tool the model calls just-in-time) → `WRITE-BACK` with explicit conflict resolution (`ADD / UPDATE / DELETE / NOOP`).
- **File/markdown memory has quietly won the coding-agent world** (CLAUDE.md, AGENTS.md, Cursor/Windsurf/Copilot rules, Claude Code's auto `MEMORY.md` index). The winning pattern is *progressive disclosure*: a tiny always-loaded **index** + one-fact-per-file leaves loaded only on relevance. It wins on transparency, git-auditability, zero infra, and user-editability; it breaks down past a few hundred shared entries or when paraphrase-robust recall is required.
- **The hard parts are not storage — they are maintenance and safety.** Conflict resolution (Mem0's CRUD resolver, Zep's bi-temporal edge invalidation), bounding size (dedup, consolidation, decay/TTL), context budgeting against **"context rot"** (more context measurably degrades every frontier model), and **memory poisoning** (a stored prompt injection survives session resets and is re-trusted as the agent's own past) are the recurring engineering problems. Gemini's response — a **default-suppressed, provenance-annotated** profile that only applies to subjective queries — is a notable in-the-wild mitigation.
- **For TinyChat specifically**, the stack makes the "curated profile-doc in existing per-space SQLite, injected as a system message" approach the natural, low-risk v1 — and TinyCloud's sovereign per-space storage is an unusually good fit for the user-owned, user-editable memory model that Anthropic, OpenAI, and Google have already made a product expectation. Two stack findings sharpen the build: (1) assistant-ui has a **native model-context registration API** (`aui.modelContext().register(...)`), so "inject a system prompt" is a supported one-call registration, not an adapter monkey-patch; and (2) sovereignty is **engineerable today** (SQLCipher-encrypted per-space SQLite + user-held keys + on-device embeddings), but it imposes a hard constraint: server-side semantic retrieval is incompatible with a literal end-to-end-encryption claim because embeddings are reversible to near-original text.

---

## 2. How Claude Does It

Anthropic ships **three distinct, non-overlapping** memory systems. They differ on *who writes the memory*, *where it lives*, and *whether it is pushed in proactively or pulled in just-in-time*.

### 2.1 Claude.ai consumer — actually two sub-features

| Sub-feature | Mechanism | Storage | Injection |
|---|---|---|---|
| **Search and reference chats** | RAG over *raw* past conversations via on-demand `conversation_search` / `recent_chats` tool calls (visible in transcript). No summarization. | Server-side; stores nothing new — queries history at request time. | **Reactive** — model calls the tool when relevant. |
| **Memory** | A *generated, editable* per-project summary/profile (role, preferences, recurring topics) synthesized from chat history, refreshed **~every 24h**. | Server-side; stores one text summary per project, user-editable. | **Proactive** — auto-injected into every new standalone chat, no tool call. |

Key product properties: **project-scoped isolation** (each Project has its own memory space; a confidential launch stays separate from client work), excludes incognito chats, deleted conversations drop out of synthesis within ~24h. Controls: view/edit summary (pencil icon or ask Claude in-chat), **Pause** (stop creating/using new memory, keep existing), **Reset** (permanent delete, no undo), **Incognito** (never saved). Rollout: search ~Aug 2025 (paid), Memory Sept 11 2025 (Team/Enterprise) → Pro/Max Oct 23 2025.

### 2.2 Claude Code — CLAUDE.md (human-authored) + auto MEMORY.md (Claude-authored)

- **CLAUDE.md** is loaded **in full** at every session start via a directory walk. Load order broad→specific: managed policy → user `~/.claude/CLAUDE.md` → project `./CLAUDE.md` → local `./CLAUDE.local.md`. All discovered ancestor files are **concatenated** (not overridden), root-down so the closest-to-cwd is read last; subdirectory CLAUDE.md files load **lazily** only when Claude touches files there.
- Critically, it is injected **as a user message *after* the system prompt** — so it is *guidance, not enforcement*. (Anything that MUST happen belongs in deterministic hooks, not memory text.) `@path` imports expand inline (max depth 4; do **not** save tokens). `#` quick-adds a fact; `/memory` views/edits.
- **Auto memory** is a *separate, Claude-written* system: Claude decides what to save (build commands, debugging insights) into `~/.claude/projects/<project>/memory/` with a **`MEMORY.md` index** (only first **200 lines / 25KB** loaded per session) + topic files loaded on demand. Machine-local, shared across worktrees of one repo, not synced across machines. *(This is exactly the system backing the user's own `~/.claude/.../memory/MEMORY.md`.)*

### 2.3 The API memory tool — model-driven, client-stored

- Tool `type: memory_20250818`, beta header `context-management-2025-06-27`. Claude emits tool calls; **the developer's app executes them** against any backend (filesystem/DB/cloud/encrypted). **Anthropic stores nothing** — the tool is explicitly client-side ("you control where and how the data is stored through your own infrastructure") and therefore **ZDR-eligible and HIPAA-eligible**.
- Commands, all scoped to `/memories`: `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. An auto-injected instruction tells Claude to **always `view /memories` before doing anything** and to assume context may reset at any moment.
- Pairs with **context editing** (client-side clearing of stale tool calls) and **compaction** (server-side summarization) so critical info survives summary boundaries. Note the data-handling asymmetry: **server-side compaction is ZDR-eligible but HIPAA=No** — it is a stateless plaintext round-trip through Anthropic, so under an E2E model it is a deliberate exposure boundary (keep summarization client-side if you need strict E2E). Anthropic-reported: +39% on an agentic eval (memory + context editing), and **~84% token reduction** in a 100-turn web-search eval.
- **Security mandate**: path-traversal protection (reject `../` and `%2e%2e%2f`, canonicalize, verify containment under `/memories`), size caps, pagination.
- **Why this matters for sovereignty**: because storage is the developer's, TinyCloud's per-space SQLite is *exactly the backend Anthropic expects you to bring* — and it can be the encrypted-at-rest store described in §8.4. The memory tool is the natural model-facing interface for a sovereign design.

### 2.4 Contrast

| | Consumer | Claude Code | API memory tool |
|---|---|---|---|
| **Who writes** | Anthropic (synthesis) + user edits | Human (CLAUDE.md) / Claude (auto MEMORY.md) | Claude (model-driven) |
| **Where stored** | Anthropic-hosted | Local markdown files | **Developer's backend** |
| **Format** | Generated summary + raw history | Plain markdown | Files under `/memories` |
| **Retrieval** | Proactive summary + reactive search | Full-load + lazy topic files | Model calls `view` |
| **Reusable for an app?** | Pattern only | Pattern only | **Directly reusable primitive** |

**Unifying theme:** transparent, user-editable **file/markdown** memory rather than opaque vector stores — Anthropic deliberately chose files over embeddings across all three surfaces.

---

## 3. How ChatGPT Does It

A **two-tier** system, both feeding the personalization layer of the system prompt.

### 3.1 Tier 1 — Saved memories (the `bio` tool)

- Launched Feb 2024. Powered by an internal **`bio` tool**: the model writes discrete, **timestamped fact strings** (`1. [2024-04-26]. User loves dogs.`) into a **`# Model Set Context`** block prepended to every chat. Triggered by user ("remember that…") *or* model-inferred salience.
- **Auditable**: entries map 1:1 to the **Manage Memories** UI; individually editable/deletable. A **"Memory updated"** toast fires on write.
- **Deduplicated/consolidated**: "I love dogs" + "I love cats" → one entry "User loves dogs and cats." One (unconfirmed) reverse-engineering claim: user-authored Model Set Context is the precedence "source of truth" on conflict.

### 3.2 Tier 2 — Reference chat history (the broad recall layer)

- Rolled out **April 10 2025** (Plus/Pro; initially excluded UK/EU/EEA+Switzerland), **June 3 2025** (Free, lighter version). **Not** user-auditable as a list — mutable, summary-based.
- **The mechanism is the headline finding (and it is community inference, not OpenAI-published):** the best live-system-prompt extractions (Willison, Embrace The Red, shloked.com, manthanguptaa) converge on **NO RAG / NO vector DB / NO knowledge graph**. Instead, several **pre-computed, periodically-refreshed sections are injected wholesale** every message:
  - *Assistant Response Preferences* (~15 inferred style prefs with confidence tags)
  - *Notable Past Conversation Topic Highlights*
  - *Helpful User Insights* (~14 profile facts)
  - *Recent Conversation Content* (~40 recent chat summaries — **user messages only**, assistant replies stripped to save tokens)
  - *User Interaction Metadata* (device, model-usage mix, message-quality stats)
- A **token budget** governs how much fits; oldest content rolls off **by token count**, not message count.
- *Mark as uncertain:* a minority of secondary write-ups still assert embedding retrieval. OpenAI has published none of the internals; treat any specific retrieval claim as inference. The defensible read: **saved memories = static injected block; chat-history = periodically-refreshed summaries injected wholesale, gated by token budget.**

### 3.3 Extraction, UX, custom instructions

- **Salience auto-decided** by the model ("info that might be useful for future conversations"); community signal favors repeated/patterned mentions, skips one-off details/dates/numbers. (An arXiv study — academic, not OpenAI — claims ~96% of memories are system-initiated, 28% contain GDPR personal data, 52% psychological inferences.)
- **Controls**: view/edit/delete at Settings → Personalization → Manage memories; "forget that" in chat; **independent toggles** for each tier. **Temporary Chat** neither reads nor writes memory (the clean-context escape hatch). **Deleting a chat does NOT delete memories derived from it** — must delete separately.
- **Scoping**: GPTs have separate opt-in memory; Projects have isolated memory; memories not shared with GPT builders. By 2025 personalization also pulls from files and connected apps (e.g., Gmail).
- **Custom Instructions vs Memory**: Custom Instructions = fixed, user-authored, non-negotiable; Memory = auto-updated, growing. Both inject into the personalization layer; recommended to use together.

---

## 4. How Gemini Does It

Google shipped automatic personal-context memory in Gemini on **Aug 13 2025** (same day as Temporary Chats and the "Keep Activity" rename). It is a genuinely **distinct third consumer pattern**, and the strongest single confirmation of the "leading products avoid heavy RAG" thesis: Gemini's memory is **one injected document, not retrieval**. It also complicates the ChatGPT/Claude framing — Gemini is the #2-by-usage assistant and does memory differently from both.

### 4.1 The `user_context` document

- Gemini consolidates what it learns into a **single typed document called `user_context`** — a sectioned outline of short factual bullets, *not* fragmented memory modules. Sections separate facts by **"half-life"**: demographics/career (rarely change), interests/preferences/long-term goals, relationships, and dated events/projects/plans (tagged with approximate time). A second reverse-engineering teardown corroborates a fixed schema (Demographics & Career; Technical Domain & Interests; Recent Activity & Status; Personal Preferences). This single-artifact design contrasts with ChatGPT (fragmented across logs, explicit memories, summaries) and Claude (raw history queried via tools + per-project summaries).
- **Per-fact provenance + temporal grounding (the standout idea):** each bullet is annotated with an explicit *rationale* tying the fact to the source interaction and date — e.g. `Statement: The user is a 26-year-old builder-researcher. (Rationale: User explicitly stated on June 18, 2025...)`. This shifts memory from "the model somehow knows this" to "the model knows this because you said X on date Y," enabling conflict resolution (recent overrides stale), distinguishing time-bound facts from permanent traits, user inspectability, and clean deletion. Teardowns call Gemini "the first mainstream chatbot to surface this temporal grounding so explicitly." *(Caveat: the rationale-annotation format is from a detailed teardown corroborated by leaked prompts, not Google-published; treat the exact format as likely, not confirmed.)* The annotations roughly **double** the memory block size and inference cost.

### 4.2 The default-suppressed injection guard (the standout safety mechanism)

Leaked Gemini system prompts (late 2025 / early 2026) contain a **MASTER RULE** that makes `user_context` **OFF-LIMITS BY DEFAULT** — the block is injected alongside every prompt but gated:

- **Query-type gate:** personalization is authorized *only* when the query seeks recommendations, advice, planning, subjective preferences, or decision support. For "strictly objective, factual, universal, or definitional" queries, user data must **not** be used.
- **Strict Necessity Test + Zero-Inference Rule + Domain Isolation:** even when authorized, use *only* the specific minimal data point needed; no extra unsolicited personalization; no inferring beyond what is stated.
- **No Hedging rule:** the assistant is "strictly forbidden" from prefatory clauses that summarize the user's attributes — explicitly banning "Based on what you know about me…", "Since you…", "You've mentioned…".
- **Sensitive-data restriction:** the prompt blocks **inference** of ~15 sensitive categories (health/mental and physical, religious beliefs, sexual orientation, political opinions, etc.) and bans surfacing any sensitive data **unless explicitly requested** — a built-in over-personalization / poisoning guard.
- Deletion/"forget" requests must be honored.

### 4.3 Update pipeline, controls, and the opt-in connected-apps tier

- **Injection, not RAG:** the whole `user_context` document is passed alongside every prompt; a **background summarization pipeline** refreshes it periodically (not real-time, so there is acknowledged **refresh lag**). Unprocessed recent turns act as an authoritative **delta — "recent conversation turns override any relevant data retrieved from `user_context` if there's a conflict."** *(Likely, from teardown analysis.)*
- **Model gating:** at the Aug 2025 launch `user_context` was restricted to slower "thinking" **Pro** models; **Flash did not access it** — richer-reasoning models bear the cost of the larger annotated block. (Google's blog: rolled out on 2.5 Pro first, Flash "in the weeks ahead.")
- **Controls / inspectability:** on by default in select countries; requires 18+, a personal Google account, "Keep Activity" enabled. Users inspect/correct/delete via Settings → Personal context → "Your past chats with Gemini," can ask "What do you know about me?" and "Did you use any info from past chats?", and correct facts by telling Gemini directly (short delay before deletions take effect). Provenance annotations make "How do you know this about me?" answerable.
- **Temporary Chats** (same-day launch) bypass the whole pipeline: not used to personalize or train, kept **up to 72 hours** only — the "incognito for AI" escape hatch.
- **Naming/scope evolution:** the Aug 2025 chat-derived **"Personal context"** (on by default, Pro models, US/select countries) was later joined by **"Personal Intelligence"** — an **opt-in (off by default)** layer connecting broader first-party data (Gmail, Photos, Maps, Calendar, Drive, YouTube, Search), with global rollout ~April 14 2026 (EEA/UK/Switzerland and Workspace/enterprise/education excluded; Google states it "does not train directly on your Gmail or Photos data"). The default split is instructive: **derived-from-conversation memory defaults on; pulling in external/structured personal data is explicit opt-in per source.** Teardowns note the chat-derived `user_context` initially *under-capitalized* on Google's structural data advantage; Personal Intelligence is the move to close that gap.

### 4.4 Why Gemini matters for TinyChat

Gemini contributes three directly transferable, low-cost ideas:

1. **Provenance UX** — store `{fact, source_msg_id, timestamp}` so every remembered fact cites its source message and date. This makes "How do you know this?" answerable, lets users delete a fact by deleting its source interaction, and lets newer statements supersede stale ones via date comparison. Cheap to implement; exactly the "what the assistant remembers" surface TinyChat wants.
2. **Default-suppressed injection guard** — don't let stored memory steer responses unconditionally. Gating memory to *subjective/advice/planning* queries (never objective/factual ones), plus a minimal-data rule, **limits the blast radius of a poisoned memory bullet** (a poisoned fact can't influence a factual answer if the gate blocks memory there). A concrete, in-the-wild mitigation for the §8 poisoning threat.
3. **Sensitive-data class restriction** — a ready-made guardrail list (health/religion/sexuality/politics) that memory must not infer or surface unless explicitly requested.

Two tradeoffs carry over too: provenance annotations roughly double block size/cost, and the update pipeline is **eventually consistent with refresh lag** — both align with TinyChat's existing eventual-consistency/latency constraints.

---

## 5. memory.md / File-Based Memory Systems

AI coding tools converged on **plain-markdown instruction/memory files loaded at session start**, splitting into two families:

1. **Human-authored "rules"** (you write, the tool injects): CLAUDE.md, AGENTS.md, Cursor `.mdc`, Windsurf rules, Copilot `*.instructions.md`, Aider `CONVENTIONS.md`, Cline Memory Bank.
2. **Agent-authored "auto memory"** (the model curates): Claude Code's `MEMORY.md` index + one-file-per-fact.

### 5.1 The landscape

| Tool | File(s) | Discovery / scoping | Activation modes | Notable constraint |
|---|---|---|---|---|
| **Claude Code** | CLAUDE.md (hierarchical) + `.claude/rules/*.md` | Directory walk, concatenate root-down; rules scoped by `paths:` frontmatter | Full-load; rules path-gated | Injected as **user msg** (guidance, not enforcement); <~200 lines/file |
| **AGENTS.md** | `AGENTS.md` | Nearest-file-wins in monorepos | Full-load | **No required schema, no frontmatter**; Linux Foundation steward; 20+ integrations. Claude Code does **not** read it directly (use `@AGENTS.md`/symlink) |
| **Cursor** | `.cursor/rules/*.mdc` | Frontmatter `globs` | Always / Auto-Attached / Agent-Requested / Manual | Plain `.md` ignored — **frontmatter required**; keep always-apply <~2000 tokens |
| **Windsurf** | `.windsurf/rules/` | `description` / `globs` | always_on / manual / model_decision / glob | **Hard caps: 6k chars/file, 12k total** |
| **Copilot** | `.github/copilot-instructions.md` + `*.instructions.md` | `applyTo` glob | Repo-wide + path-specific **stack** (union, no override) | No merge-conflict logic — additive |
| **Aider** | `CONVENTIONS.md` | **No auto-discovery** — explicit `/read` or config | Read-only context | Most opt-in; also reads AGENTS.md |
| **Cline/Roo** | `memory-bank/*.md` (6 files) | `.clinerules` instructions | **Read ALL files every task** | High token cost, no relevance gating |

### 5.2 The canonical "MEMORY.md index + one-fact-per-file" pattern

This is Claude Code's auto-memory (and the user's own `~/.claude` setup). Reverse-engineered from 64 live files:

- **`MEMORY.md` is a small always-loaded INDEX** (markdown links + one-line descriptions); only first **200 lines / 25KB** loads per session. Topic/fact files (`debugging.md`, `feedback_*.md`, `project_*.md`) are read on demand with the normal file tool.
- Each leaf carries uniform **YAML frontmatter `{name, description, type}`** where `type ∈ {user, feedback, project, reference}` (convention-enforced by prompt, not a parser). The **`description` field is load-balancing**: relevance is judged from it *alone*, so the body need not be read to decide relevance.
- Bodies written **synchronously during the live turn** (Write/Edit; user sees the file land — no background pipeline). Each body read is wrapped with an **age-in-days "verify this is still current"** reminder.
- **`[[wikilink]]` / Obsidian-style graphs** (Karpathy's "LLM Wiki") extend this into an agent-traversable knowledge graph with link-hygiene tooling (lint orphaned pages, broken wikilinks, stale content, auto-cross-link). Semantic variants add embeddings + graph traversal + MCP write-back — the hybrid markdown-only systems escalate to.

### 5.3 The three retrieval-gating mechanisms (increasing intelligence)

1. **Path globs** (Cursor `globs`, Copilot `applyTo`, Claude `paths:`) — auto-attach when a matching file enters context.
2. **Model-decision** (Cursor Agent-Requested, Windsurf model_decision) — model reads only descriptions and chooses.
3. **LLM side-query** — Claude Code reportedly runs a live Sonnet query that ranks memory descriptions and returns **top ~5** files (~250ms masked by async prefetch, ~256 output tokens via shared cache). Full-language relevance ("deployment" matches "CI/CD") **beats shallow cosine similarity at small scale**, with inspectable reasoning.

### 5.4 When plain-text memory is right vs when it breaks

**Right when:** zero infra desired; **transparency + git-auditability + user-editability** matter; scope is single-user/session-based; total memory ≲ a few hundred entries (the design *intentionally* caps ~200 files, injects ~5 at a time as a *behavioral* constraint that forces consolidation). Cost economics: local disk ~$0.02/GB/mo vs managed vector ~$50–200/GB/mo.

**Breaks down when:** hundreds of shared, cross-user entries; paraphrase-robust recall needed (semantic, not lexical); multi-hop relationship or temporal reasoning. At that point: add embeddings/vector search as a **hybrid layer behind the same index** — keep markdown as human-readable source of truth, vector index as a retrieval accelerator. **Avoid Cline's "read ALL files every task"** in a token-metered web app.

The universal small-memory technique is **progressive disclosure** (Skills demonstrate ~100 tokens metadata at startup → ~5k body on invocation → referenced files on demand — quoted up to 140× efficiency vs loading all docs). Loading everything causes **context rot** / reduced adherence.

---

## 6. OSS / Industry Frameworks

| Framework | Approach | Storage | Retrieval | Best for | Stars (Jun 2026) |
|---|---|---|---|---|---|
| **MemGPT / Letta** | OS-inspired hierarchy; LLM **self-edits** memory via tool calls | Core memory (in-context blocks, char-limited) + recall (paged FIFO history, all persisted in SQL) + archival (vector "disk") | Agent-driven (`archival_memory_search`, `conversation_search`; chains via `request_heartbeat`) | Autonomous self-editing agents; precision over RAG; **sleep-time** async memory rewriting | ~23k |
| **mem0** | Standalone "memory layer"; LLM extracts atomic facts | Vector (default `text-embedding-3-small`) + optional graph (**mem0g**) + KV; scoped by user/session/agent | **Hybrid** (semantic + BM25 + entity) | Simple CRUD API (`add/search/update/delete`), dedup-on-write, hosted option; **most popular** | ~57k |
| **Zep / Graphiti** | **Bi-temporal knowledge graph**; contradictions *invalidate*, not overwrite | Property graph (Neo4j/FalkorDB/Neptune/Kuzu): episode + entity + community subgraphs; 4 timestamps/edge | Semantic + BM25 + **n-hop graph traversal** + rerankers (RRF, MMR, cross-encoder) | Temporal reasoning ("what was true when"), audited domains, relationship/multi-hop | ~27k (Graphiti) |
| **LangChain / LangMem** | Classic memory **deprecated v0.3.1** → LangGraph checkpointers + BaseStore; LangMem adds long-term | Checkpointer (per-thread short-term) + BaseStore (namespaced long-term) | Manager-driven; semantic/episodic/procedural; hot-path vs background formation | Composable building blocks within LangChain stacks | ~1.5k (LangMem) |
| **LlamaIndex** | `ChatMemoryBuffer` → pluggable `Memory` + `MemoryBlock` | SQLite-backed blocks (FactExtraction, Vector, Static) | Per-block | Persistence within LlamaIndex apps | — |

**Mechanism highlights worth stealing:**
- **MemGPT overflow handling**: memory-pressure warning at ~70% of window → flush ~50% + recursive summarization at 100%.
- **mem0 write-back**: extraction (rolling summary + last m=10 msgs) → for each candidate fact, retrieve top s=10 similar, LLM picks **ADD/UPDATE/DELETE/NOOP**. Vendor-reported: ~26% accuracy over OpenAI memory on LOCOMO, ~91% lower p95 latency, ~90% token savings vs full-context. *(Vendor benchmarks; treat as directional — see §6.1.)*
- **Zep edge invalidation**: new fact contradicting an old edge sets the old edge's `invalid_at` rather than deleting — preserves full history for time-travel queries. Reports SOTA on DMR (94.8%) and LongMemEval (+15–18% vs full-context, ~1.6k tokens vs ~115k).
- **Generic vector pattern** underlies all of them, with a known **semantic-distance blind spot**: a "smoothie" query won't surface an earlier "allergic to peanuts" statement → which is *why* production systems combine BM25 + vector + sometimes graph.

### 6.1 Reading the benchmarks: temporal-graph vs vector-first (handle vendor numbers with care)

The vendor LOCOMO numbers above are **contested**, and the honest signal comes from an independent benchmark — but even that must be read carefully.

- **LongMemEval (Wu et al., ICLR 2025; arXiv:2410.10813) is the leading *independent* long-term-memory benchmark**, and it is purpose-built for the failure modes a chat product cares about: it scores five abilities including **temporal reasoning** and **knowledge updates** (fact supersession over time). 500 curated questions over timestamped multi-session chat logs (S ≈ 115k tokens / 30–40 sessions; M ≈ 500 sessions / ~1.5M tokens), with the answering model held constant (usually GPT-4o) so the benchmark isolates the *memory layer*. Its headline finding: commercial assistants and long-context LLMs show a **~30% accuracy drop** on sustained-interaction memory. This is exactly the "what was true when" / preference-change problem.
- **The directional conclusion — temporal-graph beats vector-first on temporal/knowledge-update queries — is confirmed.** The strongest per-category evidence is Zep's own LongMemEval run (a vendor source, but measured on the independent benchmark): overall **71.2% vs 60.2% full-context** (GPT-4o), with temporal-reasoning **45.1%→62.4%**, multi-session **44.3%→57.9%**, single-session-preference **20.0%→56.7%** — *but it loses* on single-session-assistant (94.6%→80.4%). So graph helps most on **cross-session temporal/preference recall** (the chat use case), and is not a free win everywhere.
- **Do NOT cite "Zep 63.8% vs Mem0 49.0%, ~15pt gap" as an authoritative neutral measurement.** That exact pairing circulates in secondary comparison blogs and conflates configs/sources; the only independent LongMemEval table I could verify (Vectorize) lists Zep at **71.2%** and does **not** list Mem0 on LongMemEval at all — and Vectorize sells a competing product (Hindsight, which conveniently tops that table at 91.4% on a *newer* model, not apples-to-apples). **Every leaderboard in this space has a product attached.**
- **The LOCOMO numbers are actively disputed.** Mem0 publicly alleged Zep's 84% LOCOMO claim was inflated by three methodology errors (adversarial category counted in numerator but not denominator; a modified "pay attention to timestamps" prompt vs the standardized baseline prompt; single run vs 10-run with std-dev), re-measuring Zep at **58.44% ± 0.20**. Mem0's own LOCOMO claims are likewise from Mem0's own paper. Treat all LOCOMO figures as contested.
- **The mechanism is real and architectural**, which is why this isn't just benchmark noise: Graphiti stores **validity windows (`valid_at`/`invalid_at`)** on every edge, so a superseded fact (old address, changed preference) is marked invalid and excluded; pure vector retrieval ranks by cosine similarity and can surface the *stale* fact when it is semantically closer to the query (e.g. "What was the customer's address before they moved?").
- **But the field moves fast and the picture is contested in both directions.** Mem0's newer "token-efficient" algorithm self-reports **~94%** on LongMemEval (vendor number) — far above the "49%" the secondary blogs attribute to it — showing a vector-first system with better extraction + an explicit "mark superseded" update path can close much of the gap without a full temporal graph. And a separate 2026 academic benchmark (**EngramaBench**, arXiv:2604.21229) found **GPT-4o full-context (0.6186) *beat* a graph memory system (0.5367)** on its composite score. So "graph only where it pays for itself" is not wrong — it is contested.

**Net guidance:** keep the "directional, dated" caveat *stronger* than vendor headlines imply. The defensible statement is: *on LongMemEval — whose categories include temporal reasoning and knowledge updates — temporal-graph systems show a consistent, sometimes large advantage over vector-first retrieval on exactly the cross-session temporal/preference-change queries a chat product needs; the precise per-vendor numbers are vendor-influenced and move quickly.* The engineering takeaway is nuanced: a chat product needs **some** mechanism for fact supersession over time (validity windows *or* an explicit update/dedup step at write time) — but you don't necessarily need a full graph to get most of the way there. **Temporal correctness is precisely one of the places a graph can "pay for itself" for a chat product** — say that, rather than implying flat/vector is universally sufficient.

---

## 7. The Canonical Architecture

A single loop recurs across ChatGPT, Claude, Gemini, Mem0, Letta, Zep, and LangMem:

```
EXTRACT → STORE → RETRIEVE → INJECT → WRITE-BACK (→ loop)
```

### 7.1 The stages

- **EXTRACT** — LLM judges salience and emits candidate facts as structured records (`{type, content, importance 1-10}`). **Run asynchronously / off the hot path** (session end, N turns, or idle) — inline extraction adds unacceptable latency. Letta calls this **sleep-time compute**; LangMem calls it **background formation**; Gemini's is a **background summarization pipeline** (with acknowledged refresh lag).
- **STORE** — a stable **user-profile doc** (low-churn, authoritative, always injected) + **KV/vector facts** (extracted atomic memories) + optional **temporal graph**. Always namespace by `user_id`. *Consider per-fact provenance (`source_msg_id` + timestamp) à la Gemini's `user_context` rationales — cheap, and it powers conflict resolution, decay reasoning, inspectability, and clean deletion.*
- **RETRIEVE** — the **Generative Agents hybrid score**: `score = w_rel·relevance + w_rec·recency + w_imp·importance`, each min-max normalized to [0,1]. Recency = exponential decay (factor ~0.995); importance = LLM rates 1–10 at creation; relevance = cosine similarity. This lets an *old-but-important* fact still surface. Take top-K (start K=5–10) under a token budget; bump `last_accessed_at` on hits.
- **INJECT** — render a small `<user_memory>` block in the **system prompt** (profile first, then K facts). *Or* expose a `search_memory` **tool** the model pulls just-in-time (Claude memory-tool / MemGPT style) — better for agentic products, avoids paying tokens every turn. *Gemini adds a third dimension: a **conditional injection guard** — memory is present but the model is instructed to use it only for subjective/advice/planning queries, and to prefer recent turns over stored facts on conflict.* On the assistant-ui stack these are not separate integration strategies: the `system` block and the `search_memory` tool are **two fields of the same registered `ModelContext`** (see §9).
- **WRITE-BACK** — embed the candidate, retrieve top-~10 similar existing memories, LLM picks **ADD/UPDATE/DELETE/NOOP**. Prefer **invalidate over delete** (`status=superseded`, `invalid_at=now`) to keep history.

### 7.2 Memory-type taxonomy

| Axis | Types | Maps to |
|---|---|---|
| **Duration** | Working/short-term (context window + session buffer) vs **long-term** | Checkpointer/thread vs persistent store |
| **Long-term kind** | **Semantic** (facts: profile, world facts) · **Episodic** (summaries of past events) · **Procedural** (behavior rules / persona) | Different stores & lifecycles |
| **Authority** | **User-profile** (stable, authoritative) vs **facts** (noisy, churning) | Keep profile *separate* from episodic facts so it stays clean |
| **Half-life** | Stable (demographics) vs fast-changing (current projects/plans) | Gemini's `user_context` sections facts by half-life so stable sections aren't re-summarized when only recent activity changes |

**Reflection/consolidation** (Generative Agents): triggered, not continuous — synthesize higher-level "derived" semantic memories when accumulated importance crosses a threshold (original: sum of recent importance > 150). **A-MEM** (NeurIPS 2025) extends this Zettelkasten-style: each new note links to related notes and can *evolve* them.

### 7.3 Maintenance

- **Dedup**: merge near-identical embeddings (cosine > ~0.95).
- **Conflict resolution**: ADD/UPDATE/DELETE/NOOP (Mem0), bi-temporal edge invalidation (Zep), or **recency-wins via provenance dates** (Gemini: newer dated statement supersedes the older bullet).
- **Decay / TTL**: archive/drop active memories not accessed in X days unless importance is high; bound total facts per user, summarize the tail.
- **Context rot is the budget enforcer**: Chroma's 2025 study (18 models) shows accuracy declines as context grows even on simple tasks, and "lost in the middle" drops accuracy >30% mid-context. → inject a **small, relevance-gated, deduplicated** set; put the most important memory at the **start or end** of the block, never a giant dump.

---

## 8. Storage, Privacy & Safety

### 8.1 Storage approaches compared

| Approach | What it is | Pros | Cons | Best for |
|---|---|---|---|---|
| **Flat markdown / profile doc** | One human-readable doc (or `MEMORY.md` index + leaves) injected wholesale | Zero infra; fully transparent/editable; git-auditable; cheapest; no recall failures | No semantic recall; breaks ~hundreds of entries; pays tokens every turn | Small bounded **profile + instructions**, single-user; **v1 of most products** (incl. Gemini's `user_context`) |
| **Key-value facts** | Discrete `{key/content}` strings, optionally timestamped (ChatGPT `bio`) | Auditable 1:1 with UI; easy dedup/edit/delete; cheap | Exact-match retrieval only unless paired w/ embeddings; no relationships | A short, high-signal **"saved facts" list** the user manages |
| **Vector** | Embed text, top-k cosine (+ ideally BM25) | Best price/perf for **unbounded fuzzy semantic recall**; scales | Semantic-distance blind spot; weak on multi-hop/temporal; needs access control (**embeddings leak content — see §8.3**) | Large history, paraphrase-robust recall |
| **Graph (temporal)** | Entities + fact-edges with valid/invalid timestamps | **Multi-hop + temporal** reasoning; invalidate-don't-delete; auditable history | Highest ingestion cost/latency (LLM extraction); graph DB to operate | Audited/temporal domains; relationship-heavy products |

**Reality**: most mature systems are **hybrids** (profile doc for durable identity + vector for the long tail + graph only where temporal/relational reasoning pays for itself). Flat-vs-vector-vs-graph is a **complexity/quality tradeoff, not a hierarchy** — start cheap, escalate only when recall quality is the bottleneck.

### 8.2 UX & control patterns

The control contract users now **expect** (set by ChatGPT, Claude, and Gemini):

- **Transparency** — a "Memory updated" affordance on writes; a visible "what the assistant remembers" panel. *Gemini raises the bar: per-fact **provenance** ("I know this because you said X on date Y"), answerable via "What do you know about me?" / "Did you use info from past chats?"*
- **View / edit / delete** — per-memory management UI; "forget that" in chat; clear-all.
- **Scoping / isolation** — per-project/agent/space memory that doesn't bleed across contexts; **multi-tenant isolation enforced at the namespace/row level** (every read/write filtered by `user_id`/space). A shared vector DB without per-tenant isolation is a backdoor — embeddings are often unencrypted and partially reversible to source text (§8.3).
- **Opt-out & tiering** — independent on/off toggles per memory tier; **Pause** (keep existing, stop new); a **Temporary/Incognito** mode that neither reads nor writes memory (ChatGPT Temporary Chat, Gemini Temporary Chats with 72h retention). *Gemini's default split is a useful precedent: **derived-from-conversation memory can default on; pulling in external/structured personal data (connected apps) should be explicit opt-in per source.***
- **Deletion semantics** — decide deliberately: ChatGPT's model is that deleting a chat does **not** delete derived memories (delete both); Claude's consumer Memory *does* drop deleted conversations from synthesis within ~24h; Gemini honors "forget" with a short propagation delay. Either is defensible; pick one and make it visible.

### 8.3 The serious security threat — memory poisoning

Indirect prompt injection that lands in long-term memory is **strictly worse than transient injection**: it survives session restarts/context resets, is re-retrieved across sessions, and is treated by the agent as its *own trusted past experience* (Palo Alto Unit42 + 2025–26 papers document working attacks). Defenses:

- **Treat all retrieved memory as DATA, not instructions.**
- **Vet candidate facts before commit** — flag/strip instruction-like text, policy violations, contradictions, sleeper instructions.
- **Gate memory influence by query type (Gemini's MASTER RULE pattern)** — apply memory only to subjective/advice/planning queries, never to objective/factual ones, and use only the minimal specific data point. This **bounds the blast radius**: a poisoned bullet can't steer a factual answer if the gate blocks memory there.
- **Restrict sensitive-data classes** — refuse to infer or surface health/religion/sexuality/politics from memory unless explicitly requested (Gemini's ~15-category list is a ready-made guardrail).
- **Partition reads/writes by tenant.**
- For file/tool memory: **path-traversal guards** (reject `../`, `%2e%2e%2f`, canonicalize + verify containment), **size caps**, pagination, **TTL** stale files.

### 8.4 The sovereignty gap — encryption-at-rest and the E2E constraint

The §9 sovereignty pitch and the "embeddings leak content" warning above are **engineerable with current tooling**, but they impose a hard architectural constraint the rest of the report must respect.

- **Embeddings are reversible — this confirms "shared vector DB = backdoor."** A 2025 reproducibility study of *Text Embeddings Reveal (Almost) As Much As Text* reports black-box inversion reconstructing 32-token texts at up to **97.3 BLEU / 92% exact match**, and recovering 36%/22%/4% of easy/medium/hard passwords with no task-specific training. Few-shot (ALGEN) and zero-shot "universal" inversions remove the per-model training cost. Defenses (Gaussian noise, 8-bit quantization) reduce fidelity but degrade retrieval — not a guarantee. **Treat embeddings as sensitive as plaintext.**
- **Client-side encryption is fully compatible with *literal text* memory, but fundamentally incompatible with *server-side semantic retrieval*.** This is the binding constraint on Options B/C (§9). Once a server must read content to compute over it (embeddings, shared vector DB, server-side summarization), you no longer have literal E2EE. The IACR/arXiv framework *How To Think About End-To-End Encryption and AI* is explicit: any non-trivial function of content computed off-device breaches the E2EE guarantee, AI features in E2EE systems "should generally be off by default and opt-in," and providers shouldn't make "unqualified representations that they provide E2EE" if content goes to any third party. **Apple Private Cloud Compute** — the leading production analog — openly concedes that personal-context AI in the cloud "cannot be" literally end-to-end encrypted, and substitutes *attested, no-retention, on-device-by-default* compute instead.
- **The encrypted-at-rest store is a solved primitive.** **SQLCipher** (and SQLite3 Multiple Ciphers, which runs in WASM/browser) gives transparent **AES-256 whole-file encryption** — tables, indexes, WAL, metadata — with the key derived from a passphrase. The key-custody caveat is real and specific to browsers: **JS-shipped keys cannot be hidden**, so the key must be *derived from a user secret* — for TinyCloud, the **wallet/SIWE/passkey identity already in the auth flow**. That makes "plaintext only inside the user's browser trust boundary" an engineered property, not a slogan. Envelope encryption (per-space data key wrapped by the user's master key) maps cleanly onto the per-space model.
- **The semantic-search fork in the road:**
  1. **Literal text memory + lexical/SQL filtering** — trivially E2E-compatible. *(This is the §9 Option A path.)*
  2. **On-device embeddings** (local WASM/ONNX model) stored as vectors *inside* the same encrypted SQLite — keeps E2E intact; no plaintext or vectors leave the device. A shipping reference implementation (**OMEGA**: local SQLite + local ONNX embeddings + AES-256-GCM + retention policies) shows this is buildable today. *(This is the sovereign version of Option C-vector.)*
  3. **Server/shared vector DB** — **breaks E2E** (embeddings are reversible) and is precisely the §8.3 backdoor.
  4. **Homomorphic-encryption vector search** (Heaan-style) — keeps encrypted embeddings searchable server-side, preserving E2E, but at heavy latency/compute cost and with immature tooling; a later-phase option, not a v1.
- **Anthropic's memory tool is the natural model-facing seam for all of this** — it is client-side by design (ZDR-eligible, Anthropic stores nothing), and your handler is the only thing that touches plaintext. **Caveat:** if you rely on Anthropic's *server-side* compaction to condense memory, that call is a deliberate plaintext round-trip (ZDR but HIPAA=No) — keep compaction client-side for strict E2E.

**Copy discipline (the Apple-PCC lesson):** if any step (server embeddings, shared RAG, server-side compaction) reads plaintext, do **not** claim literal end-to-end encryption. Claim "**client-side encryption with user-held keys, plaintext confined to the user's device**," and reserve E2EE language for the strictly-local path.

---

## 9. What This Means for TinyChat

### 9.1 The stack reality (what we're building into)

- **Bun monorepo** (Turborepo), **React + Vite** frontend (port 5186) using **assistant-ui**; **Express-on-Bun** backend (port 3014) that is a **stateless auth-protected SSE proxy** to **RedPill** (`openai/gpt-5-mini`).
- **Storage**: per-space **SQLite via `tinycloud.sql`**, browser-direct through `tcw.sql.db(\`${APP_ID}/threads\`)`. Tables: `threads`, `messages`, `settings`. localStorage is **cache only**, not source of truth.
- **The decisive facts:**
  1. **There is NO system prompt registered today** — but this reflects that *no model-context provider has been registered*, **not** a framework limitation. The `payload` sent to RedPill is currently exactly the visible thread history, and the `system` role is already permitted end-to-end (type union, runtime filter, RedPill accepts it). **assistant-ui ships a first-class, documented API for contributing a system message (and tools) from the frontend** — see fact 7 — so injecting one needs **no plumbing changes downstream and no array monkey-patching**.
  2. **The assembly point is `createChatModelAdapter().run()` in `frontend/src/chat/runtime.tsx`** (~lines 53–75). The idiomatic move is *not* to hand-`unshift` a `{role:'system'}` message but to **read it from `options.context.system`**, which assistant-ui populates from registered providers (fact 7).
  3. **The only existing cross-device per-user primitive is the `settings` KV table** (one key today: `active_model`). Identity is `tcw.did` (`did:pkh:…`) + `tcw.spaceId`; `cacheKey()` already isolates by `did`.
  4. **The manifest already grants `tinycloud.sql` read+write on `threads`** — a new `memory` table needs **no new permission**. SQLite authorizer **denies `CREATE INDEX`** and `execute({schema})`, but plain `CREATE TABLE IF NOT EXISTS` in the batch is allowed.
  5. **Write-back trigger** is the history adapter's `append()` (~lines 98–101), which fires per finalized message — the assistant append is the natural "turn complete" hook.
  6. **Backend injection is the wrong layer** — the backend has no access to the user's space SQL (that capability lives in the browser `tcw` session). Memory must be assembled **in the frontend**.
  7. **assistant-ui has a native model-context injection path — use it instead of patching message arrays.** `aui.modelContext().register({ getModelContext: () => ({ system, tools }) })` (also `AssistantRuntime.registerModelContextProvider(...)`, and the sugar hook `useAssistantInstructions(...)`) contributes a system message that the registry composes and delivers to the custom adapter as **`ChatModelRunOptions.context`** on every `run()`. Confirmed in source: `ModelContext = { priority?, system?, tools?, callSettings?, config? }`. Multiple providers compose deterministically (system strings joined with `\n\n`, tools shallow-merged), so a memory provider can coexist with any future instruction provider. For **frequently-changing** memory, register **once** with a `getModelContext` callback that closes over a mutable store/ref — it's evaluated fresh on each read, so the latest retrieved memory is picked up at run time without re-registering. The **same channel carries `tools`**, so a future `search_memory` tool (`makeAssistantTool`/`useAssistantTool`) is a drop-in registration, not new plumbing. *(Use the current `context`/`getModelContext` names — the older `config`/`getModelConfig`/`registerModelConfigProvider` forms were removed across v0.11–v0.14.)* If TinyChat ever moves to a server/AI-SDK runtime, the default `AssistantChatTransport` auto-forwards the frontend system message and tools to the backend — same registration works end-to-end.

### 9.2 Candidate approaches

#### Option A — Curated profile-doc memory in existing per-space SQLite (recommended v1)

A single per-user (per-space) markdown **profile document** + optionally a short **saved-facts list** (ideally with Gemini-style `{fact, source_msg_id, timestamp}` provenance), stored in a new `memory` table (or even the existing `settings` table to start). It is injected by **registering a model-context provider** (`aui.modelContext().register({ getModelContext: () => ({ system: memoryText }) })`) whose callback reads the latest memory — *not* by hand-`unshift`ing into the message array. Extraction runs **after the assistant turn** in `append()` — feed recent messages to the model (via the same RedPill proxy), ask for updated profile facts, write back via a `setMemory(tcw)` helper mirroring `setSetting`.

| Pros | Cons |
|---|---|
| **Minimal surface area** — one new table, one helper pair, **one model-context registration** (native API, no array patching), one extraction call. No new infra, no embeddings, no backend changes, no new capability. | No semantic recall over the *full* history — the long tail isn't searchable. |
| **Mirrors what ChatGPT, Claude, *and Gemini* consumer products actually do** (profile/summary injected wholesale) — proven at consumer scale. | Pays profile tokens every turn (budget it; keep it small). |
| **Syncs cross-device for free** (per-space SQLite is the source of truth). | Extraction on `append()` is client-side — runs in the user's tab; needs care to stay off the visible reply path (fire-and-forget, don't block the stream). |
| **Sovereign + user-editable by construction** — fits TinyCloud's model; trivially exposed in a "what the assistant remembers" panel; **encryptable at rest** (SQLCipher + wallet-derived key, §8.4). | Conflict resolution is coarse (regenerate/patch the doc) vs fine-grained ADD/UPDATE/DELETE — though **provenance dates give cheap recency-wins** (Gemini pattern). |

#### Option B — Vector / RAG recall layer

Embed past turns/extracted facts, retrieve top-k per query, inject. **Problem for this stack:** there is no vector store, no embedding endpoint wired in, and SQLite-via-tinycloud.sql **can't `CREATE INDEX`** (so no ANN index in-space). You'd either embed in JS and brute-force cosine over rows (fine at small scale, but every query reads/decodes all vectors client-side) or stand up an external vector service the browser calls — which **breaks the sovereign, capability-scoped model**. Per §8.4 this is the *binding* objection, not a soft one: **shipping embeddings to a shared vector DB breaks any E2E/sovereign claim because embeddings are reversible to near-original text (up to ~92% exact match).** The sovereign-compatible form of this option is **on-device embeddings stored inside the encrypted per-space SQLite** (the OMEGA pattern), brute-forced or HNSW-in-JS at small scale — never a shared backend. RedPill's embedding support is **an open question** (it's OpenAI-compatible, but unverified here).

| Pros | Cons |
|---|---|
| Paraphrase-robust recall; scales to large history. | **No infra today**; conflicts with no-CREATE-INDEX constraint; client-side brute-force or external service. |
| Bounds per-turn token cost vs always-inject. | **Server/shared embeddings break E2E (reversible) → undercuts sovereignty.** Sovereign form requires an on-device embedding model. Heavier than the product needs at current scale. |

#### Option C — Hybrid (profile doc now, retrieval later)

Ship **Option A**, keep the profile doc as the **authoritative source of truth**, and add a **retrieval accelerator later** *only if* recall over the long tail becomes the bottleneck. The retrieval layer can be the cheap **LLM side-query over memory descriptions** that Claude Code uses (**no embeddings needed**, so it sidesteps the §8.4 embedding-inversion problem entirely) or, if semantic recall is truly required, **on-device embeddings inside the encrypted SQLite** (never a shared vector DB). For temporal correctness (§6.1), add an explicit **"mark superseded" update path** (validity dates on facts) rather than a full graph. The retrieval layer sits *behind* the same memory store. This is the escalation path every file-based system follows.

| Pros | Cons |
|---|---|
| Best long-term shape; defers complexity until justified; profile stays clean/authoritative; **LLM-side-query route avoids embeddings (and their inversion risk) entirely**. | Two systems to maintain eventually; needs the retrieval question (LLM-side-query vs on-device vector) resolved when you get there. |

### 9.3 Recommendation rationale

**Start with Option A, architected toward Option C.** Reasons:

1. **The stack actively favors it** — no system prompt to retrofit, the `system` role is already plumbed, **assistant-ui's native model-context registration makes injection a one-call provider** (not an adapter hack), the SQL capability + manifest grant already exist, and per-space SQLite gives free cross-device sync and sovereignty. The *entire* v1 is a new table + helpers + one model-context registration + one async extraction call.
2. **It matches the proven consumer pattern.** ChatGPT, Claude *and Gemini* consumer memory are, at core, "a user-editable profile/summary injected into context" — *not* RAG. At single-user-per-space scale, that bet (tolerate some irrelevant context, skip embedding infra) is exactly right — and Gemini is the strongest confirmation: its entire memory is one injected document.
3. **It respects TinyChat's values — and §8.4 makes sovereignty engineerable, not just aspirational.** User-owned, inspectable, editable memory in the user's own space is the sovereignty story; make it real by **encrypting the per-space SQLite at rest (SQLCipher) with a wallet/SIWE-derived key**, so plaintext memory only ever exists in the user's browser. A vendor vector DB is the opposite — and per §8.4 would also break any honest E2E claim.
4. **Escalation is clean.** Keep the markdown/profile records as source of truth; bolt on retrieval (**LLM-side-query first — no embeddings, no inversion risk**; on-device vector only if truly needed) behind the same store when the long tail demands it — no rewrite. The same model-context registration grows a `search_memory` tool with no new integration surface.

**Non-negotiables to build in from day one** (cheap now, expensive to retrofit):
- **Scope every read/write by `tcw.did`/`spaceId`** (already the isolation primitive via `cacheKey()`).
- **Encrypt the memory store at rest** with a user-held (wallet/SIWE-derived) key, and never ship embeddings to a shared backend (§8.4). Plaintext and any vectors stay in the browser trust boundary.
- **Keep injected memory small and relevance-gated** (context rot is real even at gpt-5-mini scale); budget the token cost; put the most important memory at the **start** of the block.
- **Treat extracted memory as untrusted data, not instructions** — vet candidate facts for injected instructions before persisting (memory poisoning survives across sessions). **Consider Gemini's query-type gate** (apply memory to subjective/advice/planning queries, not objective/factual ones) to bound a poisoned fact's blast radius, plus the sensitive-data-class restriction.
- **Add per-fact provenance** (`source_msg_id` + timestamp) from day one — near-free, and it powers the "how do you know this?" UX, recency-wins conflict resolution, and delete-by-source.
- **Run extraction off the visible reply path** (fire-and-forget after `append()`; never block the SSE stream).
- **Expose a "what the assistant remembers" view with edit/delete** + a Temporary/Incognito mode that neither reads nor writes — now an expected control.

### 9.4 Open questions to resolve before building

1. **Profile doc vs discrete facts (or both)?** A single regenerated markdown doc (simplest, Claude/Gemini-style) vs a short `bio`-style auditable fact list (better UX for edit/delete) vs both (profile = stable layer, facts = churning layer). The taxonomy (§7.2) says keep profile separate from facts; Gemini's half-life sectioning is a cheap middle ground (one doc, sectioned by stability).
2. **Extraction trigger & cost.** Per-`append()` is simplest but runs a model call per assistant message through the same RedPill proxy — acceptable cost/latency? Or debounce to session-end / every N turns / idle? (Production consensus: off the hot path; Gemini accepts refresh lag for this reason.)
3. **Who runs extraction — frontend or a new backend job?** Frontend keeps the SQL capability local (no delegation) but runs in the user's tab; a backend job would need a delegation of the SQL capability the backend doesn't currently hold. Default to frontend fire-and-forget unless that proves unreliable.
4. **Conflict resolution granularity.** Regenerate-the-whole-doc (simple, coarse) vs fine-grained ADD/UPDATE/DELETE/NOOP (Mem0-style, needs similarity lookup — harder without indexing) vs **recency-wins via provenance dates** (Gemini-style, cheap). Probably regenerate + provenance dates at v1.
5. **Scope boundary.** Is memory per **space** (one identity) or per **thread/project** (ChatGPT/Claude/Gemini all isolate per project)? The settings table is per-space today; per-thread memory would need a thread key.
6. **Deletion semantics.** Does deleting a thread purge memories derived from it (Claude-consumer style) or not (ChatGPT style)? **Provenance (`source_msg_id`) makes delete-by-source trivial** and re-extraction possible since raw `messages` persist.
7. **Storage shape under the no-`CREATE INDEX` constraint.** A single `memory(key,value)` row (like `settings`) vs a richer `memory(id, type, content, importance, source_msg_id, created_at, ...)` table — the latter is fine *without* indexes at small scale but unindexed scans grow with fact count. **Also decide encryption: plain `tinycloud.sql` rows vs an app-level encrypted blob** (or SQLCipher-style whole-file encryption if/when available in the `tcw.sql` layer) — see §8.4.
8. **Token budget & placement, plus a query-type injection gate.** How many tokens for the memory block, place it at the **start** of the system content (context-rot mitigation), and **should memory be conditionally injected** (Gemini-style: only for subjective/advice/planning turns) to save tokens and bound poisoning risk?
9. **Does RedPill expose an embeddings endpoint?** (Gates whether server-side Option B/C-vector is even available — though per §8.4 the sovereign answer is **on-device embeddings or the LLM-side-query route** regardless.) **Unverified.**
10. **Multi-device write conflicts.** Two tabs/devices extracting and writing memory concurrently — last-write-wins on the SQL row, or merge? (Per the KV-concurrency memory note, tolerate eventual consistency — as Gemini's background pipeline does.)

---

## 10. Sources

**Claude / Anthropic**
- https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- https://claude.com/blog/memory
- https://claude.com/blog/context-management
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/skills
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention
- https://www.anthropic.com/news/context-management
- https://simonwillison.net/2025/Sep/12/claude-memory/

**OpenAI / ChatGPT**
- https://openai.com/index/memory-and-new-controls-for-chatgpt/
- https://help.openai.com/en/articles/8590148-memory-faq
- https://help.openai.com/en/articles/8983136-what-is-memory
- https://help.openai.com/en/articles/11146739-how-does-reference-saved-memories-work
- https://techcrunch.com/2025/04/10/openai-updates-chatgpt-to-reference-your-other-chats/
- https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/
- https://simonwillison.net/2025/May/21/chatgpt-new-memory/
- https://www.shloked.com/writing/chatgpt-memory-bitter-lesson
- https://manthanguptaa.in/posts/chatgpt_memory/
- https://github.com/0xeb/TheBigPromptLibrary/blob/main/Articles/chatgpt-bio-tool-and-memory/chatgpt-bio-and-memory.md

**Google / Gemini**
- https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/
- https://www.shloked.com/writing/gemini-memory
- https://github.com/asgeirtj/system_prompts_leaks/blob/main/Google/gemini-3.1-pro.md
- https://support.google.com/gemini/answer/16598469?hl=en&co=GENIE.Platform%3DAndroid
- https://medium.com/@rushikeshchavan_99600/inside-geminis-memory-context-user-profiles-and-personalization-87bc1ae4ba18
- https://blog.google/innovation-and-ai/products/gemini-app/personal-intelligence/
- https://9to5google.com/2025/08/13/gemini-personal-context/
- https://9to5google.com/2026/04/14/gemini-personal-intelligence-global/
- https://github.com/EliFuzz/awesome-system-prompts/blob/main/leaks/gemini/2026-01-28_prompt_gemini3fast.md

**File/markdown memory & coding-agent rules**
- https://nicolasbustamante.com/blog/agent-memory-engineering
- https://harrisonsec.com/blog/claude-code-memory-first-principles-tradeoffs/
- https://agents.md
- https://cursor.com/docs/context/rules
- https://windsurf.com/university/general-education/creating-modifying-rules
- https://docs.github.com/en/copilot/how-tos/configure-custom-instructions-in-your-ide/add-repository-instructions-in-your-ide
- https://docs.cline.bot/features/memory-bank
- https://aider.chat/docs/usage/conventions.html
- https://github.com/Ar9av/obsidian-wiki
- https://alexop.dev/posts/stop-bloating-your-claude-md-progressive-disclosure-ai-coding-tools/

**OSS frameworks & benchmarks**
- https://arxiv.org/pdf/2310.08560 (MemGPT)
- https://docs.letta.com/guides/agents/memory/
- https://www.letta.com/blog/memory-blocks
- https://www.letta.com/blog/sleep-time-compute
- https://github.com/letta-ai/letta
- https://github.com/mem0ai/mem0
- https://arxiv.org/html/2504.19413v1 (mem0 paper)
- https://mem0.ai/research-3
- https://mem0.ai/research
- https://mem0.ai/blog/state-of-ai-agent-memory-2026
- https://arxiv.org/html/2501.13956v1 (Zep/Graphiti)
- https://blog.getzep.com/state-of-the-art-agent-memory/
- https://blog.getzep.com/content/files/2025/01/ZEP__USING_KNOWLEDGE_GRAPHS_TO_POWER_LLM_AGENT_MEMORY_2025011700.pdf
- https://github.com/getzep/graphiti
- https://github.com/getzep/zep-papers/issues/5
- https://arxiv.org/abs/2410.10813 (LongMemEval, ICLR 2025)
- https://proceedings.iclr.cc/paper_files/paper/2025/hash/d813d324dbf0598bbdc9c8e79740ed01-Abstract-Conference.html
- https://github.com/xiaowu0162/LongMemEval
- https://github.com/vectorize-io/hindsight-benchmarks/blob/main/README.md
- https://vectorize.io/articles/mem0-vs-zep
- https://atlan.com/know/zep-vs-mem0/
- https://atlan.com/know/best-ai-agent-memory-frameworks-2026/
- https://arxiv.org/abs/2604.21229 (EngramaBench)
- https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- https://docs.langchain.com/oss/python/concepts/memory
- https://python.langchain.com/docs/versions/migrating_memory/conversation_buffer_memory/
- https://hindsight.vectorize.io/blog/2026/03/30/llamaindex-agent-memory
- https://vectorize.io/articles/mem0-vs-letta
- https://www.langchain.com/blog/langmem-sdk-launch

**Architecture, retrieval science & security**
- https://ar5iv.labs.arxiv.org/html/2304.03442 (Generative Agents)
- https://arxiv.org/abs/2502.12110 (A-MEM)
- https://www.understandingai.org/p/context-rot-the-emerging-challenge
- https://unit42.paloaltonetworks.com/indirect-prompt-injection-poisons-ai-longterm-memory/
- https://mem0.ai/blog/ai-memory-security-best-practices
- https://www.mindstudio.ai/blog/semantic-memory-search-ai-agents-vector-databases-2
- https://arxiv.org/html/2507.07700v1 (embedding inversion reproducibility study)
- https://arxiv.org/html/2412.20231v2 (How To Think About E2EE and AI)
- https://arxiv.org/abs/2412.20231
- https://security.apple.com/blog/private-cloud-compute/
- https://intellyx.com/2026/02/05/heaan-homomorphic-encryption-for-vector-search-and-ai-solutions/
- https://www.subhashdasyam.com/2025/11/building-privacy-preserving-rag-with.html
- https://omegamax.co/
- https://fast.io/resources/ai-agent-storage-encryption/

**Encryption-at-rest primitives**
- https://www.zetetic.net/sqlcipher/
- https://github.com/sqlcipher/sqlcipher
- https://sqlite.org/wasm/doc/trunk/see.md
- https://utelle.github.io/SQLite3MultipleCiphers/docs/ciphers/cipher_sqlcipher/

**assistant-ui (model-context injection path)**
- https://www.assistant-ui.com/docs/copilots/model-context
- https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/core/src/model-context/types.ts
- https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/core/src/runtime/utils/chat-model-adapter.ts
- https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/core/src/model-context/registry.ts
- https://raw.githubusercontent.com/assistant-ui/assistant-ui/main/packages/core/src/react/model-context/useAssistantInstructions.ts
- https://www.assistant-ui.com/docs/guides/context-api
- https://www.assistant-ui.com/docs/api-reference/runtimes/AssistantRuntime
- https://www.assistant-ui.com/docs/runtimes/ai-sdk/v6
- https://www.assistant-ui.com/docs/copilots/make-assistant-tool
- https://github.com/assistant-ui/assistant-ui/commit/040d469acfcf782de6fc188c646dfd8732d27088
- https://www.assistant-ui.com/blog/2025-01-31-changelog

**TinyChat insertion points** (from stack grounding): `frontend/src/chat/runtime.tsx` — register a model-context provider so the memory system message arrives as `options.context.system` in `createChatModelAdapter().run()` (~L53–75); `append()` write-back (~L98–101); `frontend/src/lib/threadStore.ts` (schema + `getMemory`/`setMemory`, optional encryption-at-rest); `frontend/src/lib/chatApi.ts`, `backend/src/routes/chat.ts`, `manifest.json`.
---

*Research compiled 2026-06-02 via multi-agent web research (Claude/ChatGPT/Gemini memory, file-based memory systems, OSS frameworks, architecture & security), grounded in the tinychat stack. See §10 for sources.*
