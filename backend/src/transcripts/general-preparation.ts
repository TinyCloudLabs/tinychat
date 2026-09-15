import {
  applyCheckpoint,
  buildSummarizationMessages,
  COMPACT_TARGET_RATIO,
  COMPACT_TRIGGER_RATIO,
  COMPACTION_SUMMARY_MAX_TOKENS,
  estimatePayloadTokens,
  isCheckpointValid,
  planCompaction,
  type CompactionCheckpoint,
  type PayloadMsgWithId,
} from "@tinyboilerplate/core";
import { contextLengthFor } from "../billing/catalog.js";
import type { ChatMsg, OrchestrateParams } from "../routes/agent-chat.js";
import {
  inMeetingSlice,
  type MeetingModelRequest,
  type BufferedMeetingModelResult,
} from "./meeting-turn.js";
export interface GeneralPreparation {
  memory: string;
  checkpoint: CompactionCheckpoint | null;
}
export function validCheckpointMetadata(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cp = value as Partial<CompactionCheckpoint>;
  return (
    typeof cp.summary === "string" &&
    !!cp.summary.trim() &&
    cp.summary.length <= 128000 &&
    typeof cp.coversThroughMessageId === "string" &&
    !!cp.coversThroughMessageId &&
    cp.coversThroughMessageId.length <= 128
  );
}
/** Called only after general classification. Private prose cannot enter checkpoint fact promotion. */
export async function prepareGeneralMessages(
  params: OrchestrateParams,
  modelCall: (
    request: MeetingModelRequest,
  ) => Promise<BufferedMeetingModelResult>,
): Promise<{
  messages: ChatMsg[];
  promptTokens: number;
  completionTokens: number;
  checkpoint?: { coversThroughMessageId: string; summary: string };
}> {
  if (!validCheckpointMetadata(params.preparation?.checkpoint))
    throw new Error("invalid_checkpoint");
  const privateIndexes = new Set<number>();
  params.messages.forEach((message, index) => {
    if (!message.private) return;
    privateIndexes.add(index);
    if (message.role === "assistant") {
      for (let prior = index - 1; prior >= 0; prior--) {
        if (params.messages[prior].role === "user") {
          privateIndexes.add(prior);
          break;
        }
      }
    }
  });
  const messages = params.messages
    .filter(
      (m, index) =>
        !privateIndexes.has(index) &&
        ["user", "assistant", "system"].includes(m.role),
    )
    .map((m, i) => ({
      id: m.id ?? `message-${i}`,
      role: m.role,
      content: m.content,
    })) as PayloadMsgWithId[];
  const memory = params.preparation?.memory ?? "";
  const prefix: ChatMsg[] = memory ? [{ role: "system", content: memory }] : [];
  const cp = params.preparation?.checkpoint;
  const valid =
    cp &&
    typeof cp.id === "string" &&
    cp.id.startsWith("ordinary-v3:") &&
    isCheckpointValid(
      cp,
      messages.map((m) => m.id),
    )
      ? cp
      : null;
  let payload = valid ? applyCheckpoint(messages, valid) : messages;
  const contextTokens = contextLengthFor(params.model);
  if (
    estimatePayloadTokens([...prefix, ...payload]) <=
    contextTokens * COMPACT_TRIGGER_RATIO
  )
    return {
      messages: [...prefix, ...payload],
      promptTokens: 0,
      completionTokens: 0,
    };
  const plan = planCompaction({
    messages,
    fixedSystemBlockChars: memory.length,
    contextTokens,
    targetRatio: COMPACT_TARGET_RATIO,
    prevCheckpoint: valid,
  });
  if (!plan.needed || !plan.coversThroughMessageId)
    return {
      messages: [...prefix, ...payload],
      promptTokens: 0,
      completionTokens: 0,
    };
  const reply = await inMeetingSlice(
    Math.min(35000, params.remainingMs?.() ?? 120000),
    params.signal,
    (signal) =>
      modelCall({
        messages: buildSummarizationMessages(plan, valid?.summary),
        phase: "model",
        maxOutputTokens: COMPACTION_SUMMARY_MAX_TOKENS,
        signal,
      }),
  );
  if (!reply.complete || !reply.content.trim() || reply.calls.length)
    throw new Error("General compaction did not complete");
  const checkpoint = {
    coversThroughMessageId: plan.coversThroughMessageId,
    summary: reply.content,
  };
  payload = applyCheckpoint(messages, {
    ...checkpoint,
    id: "pending",
    threadId: params.roomId ?? "",
    createdAt: new Date().toISOString(),
  });
  return {
    messages: [...prefix, ...payload],
    promptTokens: reply.promptTokens,
    completionTokens: reply.completionTokens,
    checkpoint,
  };
}
