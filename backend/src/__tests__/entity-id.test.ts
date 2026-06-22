import { describe, expect, it } from "bun:test";
import { addressToEntityId, stringToUuid, TINYCHAT_AGENT_ID } from "../entity-id.js";

// Golden-vector parity test (Layer-1 contract §3.3). These vectors are pinned
// against eliza-service/src/entity-id.ts and @elizaos/core stringToUuid. If any
// fails, the tinychat copy has drifted and per-user memory routing will break
// (registerDelegation and the later clientFor would land on different keys).

describe("entity-id parity", () => {
  it("canary: stringToUuid('hello') matches the contract (version nibble 0, NOT uuidv5)", () => {
    expect(stringToUuid("hello")).toBe("aaf4c61d-dcc5-08a2-9abe-de0f3b482cd9");
    // position 15 (the version nibble) is '0', confirming this is not RFC uuidv5.
    expect(stringToUuid("hello").charAt(14)).toBe("0");
  });

  it("returns a valid UUID unchanged (passthrough)", () => {
    const u = "92361e74-91ed-43a2-9656-5cc37ff3a07a";
    expect(stringToUuid(u)).toBe(u);
  });

  it("lowercase and EIP-55 checksummed addresses map to the same entityId", () => {
    const lc = "0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2";
    const checksummed = "0x7D0333579C19E8Fa149C2dbF8405Cb6f66C373f2";
    expect(addressToEntityId(lc, TINYCHAT_AGENT_ID)).toBe(
      addressToEntityId(checksummed, TINYCHAT_AGENT_ID),
    );
  });

  it("pinned address→entityId vector (byte-equal to eliza-service source)", () => {
    // Computed from both repos' entity-id.ts — the cross-repo routing contract.
    expect(
      addressToEntityId("0x7d0333579c19e8fa149c2dbf8405cb6f66c373f2", TINYCHAT_AGENT_ID),
    ).toBe("b7da5202-d81f-0f0f-a602-46f696ae2b8a");
  });

  it("the frozen tinychat agentId is unchanged", () => {
    expect(TINYCHAT_AGENT_ID).toBe("92361e74-91ed-43a2-9656-5cc37ff3a07a");
  });
});
