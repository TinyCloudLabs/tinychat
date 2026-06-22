// entityId derivation — BYTE-IDENTICAL copy of eliza-service's entity-id.ts
// (tinycloud-agents/packages/eliza-service/src/entity-id.ts) and of
// @elizaos/core stringToUuid.
//
// The tinychat backend computes the routing entityId it sends to
// eliza-service POST /sessions and POST /tools. It MUST match what the service
// (and elizaOS core) compute, or registerDelegation and the later per-user
// clientFor land on different keys and the user's memory is unreachable.
//
// This is a deliberate copy (the repos deploy separately, no shared package).
// The pinned golden-vector test in __tests__/entity-id.test.ts guards parity:
// any drift from the contract's canary fails CI.
//
// Contract: packages/eliza-service/docs/layer1-contract.md §3.
// NOT standard uuidv5 — version nibble is forced to 0.

import { createHash } from "node:crypto";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bytesToUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return (
    hex.slice(0, 4).join("") +
    "-" +
    hex.slice(4, 6).join("") +
    "-" +
    hex.slice(6, 8).join("") +
    "-" +
    hex.slice(8, 10).join("") +
    "-" +
    hex.slice(10, 16).join("")
  );
}

// Byte-identical to @elizaos/core stringToUuid.
// If target is already a valid UUID it is returned as-is.
// Otherwise: sha1(encodeURIComponent(target)), first 16 bytes,
// variant byte bytes[8] = bytes[8] & 63 | 128,
// version nibble bytes[6] = bytes[6] & 15 | 0  ← forced to 0, NOT standard uuidv5
export function stringToUuid(target: string | number): string {
  if (typeof target === "number") {
    target = target.toString();
  }
  if (typeof target !== "string") {
    throw new TypeError("Value must be string");
  }
  if (UUID_RE.test(target)) {
    return target;
  }
  const escaped = encodeURIComponent(target);
  const buf = createHash("sha1").update(escaped).digest();
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, 16);
  bytes[8] = (bytes[8] & 63) | 128;
  bytes[6] = (bytes[6] & 15) | 0;
  return bytesToUuid(bytes);
}

// Derives the elizaOS entityId for a wallet address paired with an agentId.
// Lowercases the address before seeding so EIP-55 checksummed and lowercase
// forms always map to the same UUID (sha1 is case-sensitive).
export function addressToEntityId(address: string, agentId: string): string {
  return stringToUuid(`${address.toLowerCase()}:${agentId}`);
}

// The frozen tinychat character/agent id (Layer-1 contract §2). All tinychat
// users share this agent; the entityId routing key is derived against it.
export const TINYCHAT_AGENT_ID = "92361e74-91ed-43a2-9656-5cc37ff3a07a";
