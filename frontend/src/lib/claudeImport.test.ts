import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "bun:test";
// NOTE: `INTERNAL` is an explicitly-internal surface of @assistant-ui/react.
// On every upstream bump (esp. minor versions), re-run this file: a rename or
// removal of MessageRepository would break the spec §10 round-trip probe.
import { INTERNAL, type ExportedMessageRepository } from "@assistant-ui/react";
import { strToU8, zipSync } from "fflate";

import {
  claudeMessageId,
  parseClaudeExport,
  summarizeConversations,
  toStoredItem,
} from "./claudeImport";
import { IMPORT_DEFAULT_MODEL, importThread } from "./threadStore";
import type { StoredMessageItem } from "./threadStore";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

const { MessageRepository } = INTERNAL;

/**
 * Mirror `runtime.tsx#load()` so the unit test exercises the EXACT
 * reconstruction path the production load goes through. Any drift here would
 * let the importer ship a payload load() rejects in real chats.
 */
function reconstruct(items: StoredMessageItem[]): ExportedMessageRepository {
  const valid = items.filter(
    (it) => typeof (it.message as { id?: unknown })?.id === "string",
  );
  if (valid.length === 0) return { messages: [] };
  const messages = valid.map((item, i) => ({
    ...item,
    parentId: i === 0 ? null : (valid[i - 1].message as { id: string }).id,
  }));
  const headId = (valid[valid.length - 1].message as { id: string }).id;
  return { headId, messages };
}

/** SQL/JSON round-trip mirrors what threadStore writes/reads. */
function jsonRoundTrip(items: StoredMessageItem[]): StoredMessageItem[] {
  return items.map((it) => JSON.parse(JSON.stringify(it)) as StoredMessageItem);
}

describe("toStoredItem + runtime.tsx#load() reconstruction (spec §10 probe)", () => {
  const threadId = "claude-conv-abc";
  const userTs = "2024-03-10T14:30:01.000Z";
  const asstTs = "2024-03-10T14:30:05.000Z";

  it("produces stable, threadId-scoped message ids", () => {
    expect(claudeMessageId(threadId, 0)).toBe("claude-conv-abc-0");
    expect(claudeMessageId(threadId, 7)).toBe("claude-conv-abc-7");
  });

  it("emits the locked-in payload shape for a user item", () => {
    const item = toStoredItem("user", "hello claude", userTs, 0, threadId);
    expect(item.parentId).toBeNull();
    const m = item.message as unknown as Record<string, unknown>;
    expect(m.id).toBe("claude-conv-abc-0");
    expect(m.role).toBe("user");
    expect(m.content).toEqual([{ type: "text", text: "hello claude" }]);
    // createdAt is the ISO string we passed in (typed-as-Date for the API,
    // serialized-as-string in the JSON round-trip — see claudeImport.ts).
    expect(m.createdAt).toBe(userTs);
    expect(m.metadata).toEqual({ custom: {} });
  });

  it("emits status={complete, stop} on assistant items (spec §10 confirmed)", () => {
    const item = toStoredItem("assistant", "hi back", asstTs, 1, threadId);
    const m = item.message as unknown as Record<string, unknown>;
    expect(m.role).toBe("assistant");
    expect(m.status).toEqual({ type: "complete", reason: "stop" });
    expect(m.createdAt).toBe(asstTs);
  });

  it("round-trips a hand-built user+assistant pair through MessageRepository.import", () => {
    const items: StoredMessageItem[] = [
      toStoredItem("user", "hello claude", userTs, 0, threadId),
      toStoredItem("assistant", "hi back", asstTs, 1, threadId),
    ];

    // SQL round-trip turns the typed Date back into a string — assert this is
    // what the runtime sees, then prove the runtime still accepts it.
    const fromSql = jsonRoundTrip(items);
    expect((fromSql[1].message as unknown as { createdAt: unknown }).createdAt).toBe(asstTs);

    const exported = reconstruct(fromSql);
    expect(exported.headId).toBe("claude-conv-abc-1");
    expect(exported.messages).toHaveLength(2);
    expect(exported.messages[0].parentId).toBeNull();
    expect(exported.messages[1].parentId).toBe("claude-conv-abc-0");

    // The critical assertion: assistant-ui's MessageRepository.import must not
    // throw on the payload we constructed. Anything it would reject — missing
    // id, broken parent chain, unresolvable headId — surfaces as a thrown
    // "Parent message not found" / "Branch not found" here.
    const repo = new MessageRepository();
    expect(() => repo.import(exported)).not.toThrow();

    // The head and the visible message chain reflect the imported order.
    expect(repo.headId).toBe("claude-conv-abc-1");
    const visible = repo.getMessages();
    expect(visible).toHaveLength(2);
    expect(visible[0].id).toBe("claude-conv-abc-0");
    expect(visible[0].role).toBe("user");
    expect(visible[1].id).toBe("claude-conv-abc-1");
    expect(visible[1].role).toBe("assistant");
  });
});

// ── parseClaudeExport (spec §4) ──────────────────────────────────────

const sampleConversation = {
  uuid: "conv-1",
  name: "Cover letter help",
  created_at: "2024-03-10T14:30:00.000Z",
  updated_at: "2024-03-10T15:45:00.000Z",
  chat_messages: [
    {
      sender: "human",
      text: "Hi Claude",
      created_at: "2024-03-10T14:30:01.000Z",
    },
    {
      sender: "assistant",
      text: "",
      created_at: "2024-03-10T14:30:05.000Z",
      content: [
        { type: "thinking", thinking: "Reasoning…" },
        { type: "text", text: "Hello!" },
        { type: "tool_use", name: "noop", input: {} },
        { type: "text", text: " How can I help?" },
        { type: "tool_result", content: "…" },
        { type: "unknown_future_block", foo: "bar" },
      ],
    },
  ],
};

const attachmentConversation = {
  uuid: "conv-2",
  name: "Resume review",
  created_at: "2024-04-01T09:00:00.000Z",
  updated_at: "2024-04-01T09:05:00.000Z",
  chat_messages: [
    {
      sender: "human",
      text: "Please review",
      created_at: "2024-04-01T09:00:01.000Z",
      attachments: [
        { file_name: "resume.pdf", extracted_content: "RESUME TEXT" },
      ],
      files: [{ file_name: "photo.png" }],
    },
  ],
};

const emptyConversation = {
  uuid: "conv-empty",
  name: "Just tool calls",
  created_at: "2024-05-01T00:00:00.000Z",
  chat_messages: [
    {
      sender: "assistant",
      text: "",
      content: [
        { type: "tool_use", name: "x", input: {} },
        { type: "thinking", thinking: "…" },
      ],
    },
    {
      // Unknown sender — drops out entirely.
      sender: "system",
      text: "ignored",
    },
  ],
};

const untitledConversation = {
  uuid: "conv-untitled",
  created_at: "2024-06-01T00:00:00.000Z",
  chat_messages: [
    { sender: "human", text: "hey", created_at: "2024-06-01T00:00:01.000Z" },
  ],
};

describe("parseClaudeExport — spec §4", () => {
  it("parses a JSON array payload and normalizes roles + dropped blocks", async () => {
    const out = await parseClaudeExport(
      JSON.stringify([sampleConversation]),
    );
    expect(out).toHaveLength(1);
    const [c] = out;
    expect(c.sourceId).toBe("conv-1");
    expect(c.title).toBe("Cover letter help");
    expect(c.createdAt).toBe("2024-03-10T14:30:00.000Z");
    expect(c.updatedAt).toBe("2024-03-10T15:45:00.000Z");

    expect(c.messages).toHaveLength(2);
    expect(c.messages[0]).toEqual({
      role: "user",
      text: "Hi Claude",
      createdAt: "2024-03-10T14:30:01.000Z",
    });
    // text fallback concatenates only `type: "text"` blocks; everything else dropped.
    expect(c.messages[1]).toEqual({
      role: "assistant",
      text: "Hello! How can I help?",
      createdAt: "2024-03-10T14:30:05.000Z",
    });
  });

  it("parses a JSONL payload (one object per line)", async () => {
    const jsonl = `${JSON.stringify(sampleConversation)}\n${JSON.stringify(
      attachmentConversation,
    )}\n`;
    const out = await parseClaudeExport(jsonl);
    expect(out.map((c) => c.sourceId)).toEqual(["conv-1", "conv-2"]);
  });

  it("appends attachment markers (with extracted_content) and handles files[]", async () => {
    const out = await parseClaudeExport([attachmentConversation]);
    expect(out).toHaveLength(1);
    const [m] = out[0].messages;
    expect(m.text).toContain("Please review");
    expect(m.text).toContain("[attachment: resume.pdf]");
    expect(m.text).toContain("RESUME TEXT");
    expect(m.text).toContain("[attachment: photo.png]");
  });

  it("excludes conversations with zero usable messages", async () => {
    const out = await parseClaudeExport([emptyConversation]);
    expect(out).toEqual([]);
  });

  it("falls back to 'Untitled' when name is missing", async () => {
    const out = await parseClaudeExport([untitledConversation]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Untitled");
    // updatedAt falls back to createdAt when missing.
    expect(out[0].updatedAt).toBe(out[0].createdAt);
  });

  it("never throws on unknown content blocks", async () => {
    const conv = {
      uuid: "conv-weird",
      name: "Weird",
      created_at: "2024-07-01T00:00:00.000Z",
      chat_messages: [
        {
          sender: "assistant",
          text: "",
          created_at: "2024-07-01T00:00:01.000Z",
          content: [
            { type: "image", source: { type: "base64" } },
            { type: "text", text: "ok" },
            { type: "weird_block", whatever: true },
            "not-an-object",
            null,
          ],
        },
      ],
    };
    const out = await parseClaudeExport([conv]);
    expect(out[0].messages[0].text).toBe("ok");
  });

  it("accepts a .zip and pulls conversations.json out", async () => {
    const json = JSON.stringify([sampleConversation]);
    const zipped = zipSync({ "conversations.json": strToU8(json) });
    const out = await parseClaudeExport(zipped);
    expect(out.map((c) => c.sourceId)).toEqual(["conv-1"]);
  });

  it("accepts a pre-parsed array verbatim", async () => {
    const out = await parseClaudeExport([sampleConversation]);
    expect(out).toHaveLength(1);
    expect(out[0].sourceId).toBe("conv-1");
  });

  it("treats whitespace-only top text as empty, walking content[] fallback", async () => {
    const conv = {
      uuid: "conv-ws",
      name: "Whitespace",
      created_at: "2024-08-01T00:00:00.000Z",
      chat_messages: [
        {
          sender: "assistant",
          text: "   ",
          created_at: "2024-08-01T00:00:01.000Z",
          content: [{ type: "text", text: "real reply" }],
        },
      ],
    };
    const out = await parseClaudeExport([conv]);
    expect(out[0].messages[0].text).toBe("real reply");
  });

  it("wraps a single-object JSON payload (sourceId + chat_messages) as one-element list", async () => {
    const out = await parseClaudeExport(JSON.stringify(sampleConversation));
    expect(out.map((c) => c.sourceId)).toEqual(["conv-1"]);
  });
});

describe("committed fixture: test/fixtures/claude-export.json", () => {
  const fixturePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../test/fixtures/claude-export.json",
  );

  it("parses the committed fixture: 2 usable convs (tool-only excluded), attachment marker present", async () => {
    const raw = readFileSync(fixturePath, "utf8");
    const out = await parseClaudeExport(raw);

    // 3 conversations in the fixture, but the tool-only one yields zero usable
    // messages and must be excluded per spec §4.
    expect(out.map((c) => c.sourceId)).toEqual([
      "fixture-conv-1",
      "fixture-conv-2",
    ]);

    // First conv: empty-text fallback concatenates only text blocks.
    const [conv1] = out;
    expect(conv1.title).toBe("Cover letter help");
    expect(conv1.messages).toHaveLength(3);
    expect(conv1.messages[0].role).toBe("user");
    expect(conv1.messages[1].role).toBe("assistant");
    expect(conv1.messages[1].text).toContain("Sure! Here's a starting draft:");
    expect(conv1.messages[1].text).toContain("Dear hiring manager");
    expect(conv1.messages[1].text).not.toContain("Let me draft something");

    // Second conv carries an attachment with extracted_content + a files[] entry.
    const conv2 = out[1];
    const [conv2first] = conv2.messages;
    expect(conv2first.text).toContain("Please review my resume.");
    expect(conv2first.text).toContain("[attachment: resume.pdf]");
    expect(conv2first.text).toContain("Jane Doe — Frontend Engineer");
    expect(conv2first.text).toContain("[attachment: headshot.png]");
  });
});

describe("importThread — spec §6 batch shape", () => {
  // Spec §6: one signed batch per conversation. Verify the structure rather
  // than running real SQL — the SQL service is unreachable from a unit test.
  type Stmt = { sql: string; params?: unknown[] };
  function makeMockTcw(): { tcw: TinyCloudWeb; calls: Stmt[][] } {
    const calls: Stmt[][] = [];
    const sqlDb = {
      batch: async (stmts: Stmt[]) => {
        calls.push(stmts);
        return { ok: true, data: { rows: [] } } as const;
      },
      query: async () => ({ ok: true, data: { rows: [] } }) as const,
      execute: async () => ({ ok: true }) as const,
    };
    const tcw = {
      sql: { db: () => sqlDb },
      spaceId: "test-space",
      did: "did:test",
    } as unknown as TinyCloudWeb;
    return { tcw, calls };
  }

  function findImportBatch(calls: Stmt[][]): Stmt[] {
    // ensureSchema is one batch of CREATEs; the next is the importThread batch.
    const importBatch = calls.find((b) =>
      b.some((s) => /DELETE FROM messages/.test(s.sql)),
    );
    if (!importBatch) throw new Error("import batch not recorded");
    return importBatch;
  }

  it("emits DELETE → thread upsert → ordered message inserts", async () => {
    const { tcw, calls } = makeMockTcw();
    const threadId = "claude-conv-batch";
    const userTs = "2024-09-01T00:00:01.000Z";
    const asstTs = "2024-09-01T00:00:02.000Z";
    const items: StoredMessageItem[] = [
      toStoredItem("user", "hi", userTs, 0, threadId),
      toStoredItem("assistant", "hello", asstTs, 1, threadId),
    ];
    await importThread(tcw, {
      id: threadId,
      title: "Batched",
      createdAt: "2024-09-01T00:00:00.000Z",
      updatedAt: "2024-09-01T00:00:03.000Z",
      items,
    });

    const batch = findImportBatch(calls);
    // First stmt: DELETE.
    expect(batch[0].sql).toMatch(/DELETE FROM messages WHERE thread_id = \?/);
    expect(batch[0].params).toEqual([threadId]);
    // Second stmt: thread upsert with ON CONFLICT updating created_at + updated_at.
    expect(batch[1].sql).toMatch(/INSERT INTO threads/);
    expect(batch[1].sql).toMatch(/ON CONFLICT\(id\) DO UPDATE/);
    expect(batch[1].sql).toMatch(/created_at = excluded\.created_at/);
    expect(batch[1].params).toEqual([
      threadId,
      "Batched",
      IMPORT_DEFAULT_MODEL,
      "2024-09-01T00:00:00.000Z",
      "2024-09-01T00:00:03.000Z",
    ]);
    // Message inserts: explicit position 0..n with the original message ts.
    expect(batch[2].sql).toMatch(/INSERT INTO messages/);
    expect(batch[2].params?.[1]).toBe(0);
    expect(batch[2].params?.[3]).toBe(userTs);
    expect(batch[3].params?.[1]).toBe(1);
    expect(batch[3].params?.[3]).toBe(asstTs);
  });

  it("re-import is the same DELETE+INSERT sequence (idempotent)", async () => {
    const { tcw, calls } = makeMockTcw();
    const threadId = "claude-re-import";
    const items: StoredMessageItem[] = [
      toStoredItem("user", "hi", "2024-09-01T00:00:01.000Z", 0, threadId),
    ];
    const conv = {
      id: threadId,
      title: "X",
      createdAt: "2024-09-01T00:00:00.000Z",
      updatedAt: "2024-09-01T00:00:01.000Z",
      items,
    };
    await importThread(tcw, conv);
    await importThread(tcw, conv);
    const importBatches = calls.filter((b) =>
      b.some((s) => /DELETE FROM messages/.test(s.sql)),
    );
    expect(importBatches).toHaveLength(2);
    expect(importBatches[0].map((s) => s.sql)).toEqual(
      importBatches[1].map((s) => s.sql),
    );
  });
});

describe("summarizeConversations", () => {
  it("returns one row per conversation, newest first by createdAt", async () => {
    // Pass oldest (conv-1, March) before newest (conv-2, April) to prove the
    // result is sorted by date, not by input order.
    const parsed = await parseClaudeExport([
      sampleConversation,
      attachmentConversation,
    ]);
    expect(summarizeConversations(parsed)).toEqual([
      {
        sourceId: "conv-2",
        title: "Resume review",
        createdAt: "2024-04-01T09:00:00.000Z",
        messageCount: 1,
      },
      {
        sourceId: "conv-1",
        title: "Cover letter help",
        createdAt: "2024-03-10T14:30:00.000Z",
        messageCount: 2,
      },
    ]);
  });
});
