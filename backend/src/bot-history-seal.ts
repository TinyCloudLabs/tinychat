// Thin SDK adapter for sealing bot-history batches to one exact named key (TC-3823).
// Calls the `NamedKeyClient.encrypt(..., { descriptor })` surface specified in js-sdk-spec.md
// so swapping onto the published js-sdk beta requires zero changes outside this boundary.
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type { KeyDescriptor, NamedKeyEnvelope } from "@tinycloud/sdk-services/encryption/named-keys";
import { BOT_HISTORY_KEY_PATH, type BotHistoryKeyDescriptorPayload } from "./bot-history-key.js";

export interface SealBotHistoryInput {
  networkId: string;
  plaintext: Uint8Array;
  aad: Uint8Array;
  descriptor: BotHistoryKeyDescriptorPayload;
}

/**
 * Seals one bot-history batch to the owner's verified named key descriptor.
 * Never calls network root encryption or unauthenticated public-key GET.
 */
export async function sealBotHistoryBatch(
  node: TinyCloudNode,
  input: SealBotHistoryInput,
): Promise<NamedKeyEnvelope> {
  const sdkDescriptor: KeyDescriptor = {
    networkId: input.descriptor.networkId,
    keyPath: input.descriptor.keyPath,
    alg: input.descriptor.alg,
    keyVersion: input.descriptor.keyVersion,
    publicEncryptionKey: input.descriptor.publicEncryptionKey,
    kind: input.descriptor.kind,
    state: input.descriptor.state,
  };
  let envelope: NamedKeyEnvelope;
  try {
    envelope = await node.keys.encrypt(BOT_HISTORY_KEY_PATH, input.plaintext, {
      networkId: input.networkId,
      aad: input.aad,
      descriptor: sdkDescriptor,
    });
  } catch {
    throw new Error("history_encryption_failed");
  }
  const expectedAad = Buffer.from(input.aad).toString("base64");
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.v !== 2 ||
    envelope.networkId !== input.networkId ||
    envelope.keyPath !== BOT_HISTORY_KEY_PATH ||
    envelope.aad !== expectedAad ||
    envelope.keyVersion !== input.descriptor.keyVersion
  ) {
    throw new Error("history_recipient_mismatch");
  }
  return envelope;
}
