// The fixed synthetic demo data the reviewer seed writes. Nothing here is personal or
// generated: every id and text is a constant, and every time is an offset from the
// run's `seededAt`, which the space's seed marker records so a resumed run writes the
// same bytes again. Changing anything here is a new SEED_REVISION.
import type { FeedCard } from "@tinycloud/sdk-services/feed";
import type { StoredMessageItem } from "../../src/lib/threadStore";

/** Bump when any content, id or write path changes; a space seeded at another revision is refused. */
export const SEED_REVISION = 1;
/** The settings key (TinyCloud Home's cross-device `settings` table) holding the seed marker. */
export const SEED_MARKER_KEY = "xyz.tinycloud.tinychat:reviewer-seed";
export const SEED_NAME = "tinychat-reviewer-seed";

const MINUTE = 60_000;
const at = (seededAt: string, minutesAgo: number) => new Date(Date.parse(seededAt) - minutesAgo * MINUTE).toISOString();

// ── Feed ─────────────────────────────────────────────────────────────

/** One Feed source, registered the way Home's reader expects (`xyz.tinycloud.tinychat/feed/feed_output_<token>`). */
export const FEED_AGENT = {
  agentId: "home-tour",
  token: "home_tour",
  label: "TinyCloud Home tour",
} as const;

export function feedCards(seededAt: string): FeedCard[] {
  const issuance = (cardId: string) => `${SEED_NAME}-r${SEED_REVISION}-${cardId}`;
  return [
    {
      cardId: "welcome", revision: 1, issuanceId: issuance("welcome"), kind: "update", needsResponse: false, urgency: 0,
      title: "Welcome to TinyCloud Home",
      body: "This is your Feed. Updates and questions from the tools you connect arrive here as cards. These sample cards show what that looks like.",
      createdAt: at(seededAt, 50),
    },
    {
      cardId: "first-step", revision: 1, issuanceId: issuance("first-step"), kind: "question", needsResponse: true, urgency: 1,
      title: "What would you like to try first?",
      body: "Pick one. Your answer is saved to this card in your own TinyCloud space.",
      choices: [
        { id: "chat", label: "Start a chat" },
        { id: "voice-note", label: "Record a voice note" },
        { id: "feed", label: "Look around the Feed" },
      ],
      createdAt: at(seededAt, 40),
    },
    {
      cardId: "your-space", revision: 1, issuanceId: issuance("your-space"), kind: "update", needsResponse: false, urgency: 0,
      title: "Your data stays in your space",
      body: "Chats, voice notes and Feed cards are stored in your TinyCloud space. Sign in on another device to see the same items.",
      createdAt: at(seededAt, 30),
    },
    {
      cardId: "weekly-summary", revision: 1, issuanceId: issuance("weekly-summary"), kind: "question", needsResponse: true, urgency: 0,
      title: "Would a weekly summary card be useful?",
      body: "Answer yes or no, or write a short note. This is a sample question; nothing is sent anywhere.",
      choices: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      createdAt: at(seededAt, 20),
    },
  ];
}

// ── Chat ─────────────────────────────────────────────────────────────

export const CHAT_THREAD_ID = `${SEED_NAME}-r${SEED_REVISION}-chat`;

const CHAT_TURNS: readonly { role: "user" | "assistant"; text: string }[] = [
  { role: "user", text: "What can I do in TinyCloud Home?" },
  {
    role: "assistant",
    text: "TinyCloud Home has three parts:\n\n- **Feed**: cards from the tools you connect, which you can read and answer.\n- **Chat**: conversations like this one.\n- **Voice notes**: record a note and get a transcript.\n\nEverything is saved in your own TinyCloud space.",
  },
  { role: "user", text: "Give me a short checklist for trying it out." },
  {
    role: "assistant",
    text: "1. Open the Feed and answer one of the sample questions.\n2. Record a short voice note and open its transcript.\n3. Come back to this chat and ask a follow-up question.",
  },
];

/** The chat's messages in the shape the chat runtime appends (`ExportedMessageRepositoryItem`), each parented to the one before. */
export function chatMessages(seededAt: string): StoredMessageItem[] {
  return CHAT_TURNS.map((turn, index) => {
    const id = `${CHAT_THREAD_ID}-m${index}`;
    const createdAt = new Date(at(seededAt, 15 - index));
    const content = [{ type: "text" as const, text: turn.text }];
    const message = turn.role === "assistant"
      ? {
        id, role: "assistant" as const, content, createdAt,
        status: { type: "complete" as const, reason: "stop" as const }, attachments: [],
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
      }
      : { id, role: "user" as const, content, createdAt, attachments: [], metadata: { custom: {} } };
    return { message, parentId: index === 0 ? null : `${CHAT_THREAD_ID}-m${index - 1}` } as StoredMessageItem;
  });
}

// ── Voice note ───────────────────────────────────────────────────────

/** A transcript-only voice note: the Library's paste path, so no audio is stored or played. */
export const VOICE_NOTE = {
  sourceId: `${SEED_NAME}-r${SEED_REVISION}-voice-note`,
  title: "Sample voice note: trying TinyCloud Home",
  transcript: [
    "Speaker 1: This is a sample voice note for trying TinyCloud Home.",
    "Speaker 1: Notes you record appear in the Library with a transcript you can read and search.",
    "Speaker 1: Things to try: answer a card in the Feed, start a chat, and record a note of your own.",
  ].join("\n"),
} as const;

export function voiceNoteStartedAt(seededAt: string): string {
  return at(seededAt, 60);
}
