import { describe, expect, test } from "bun:test";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { SpaceNotHostedError } from "./embedHost";
import { frameGrantDelegate } from "./frameGrant";

const SPACE = "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:public";
const entries: PermissionEntry[] = [{ service: "tinycloud.kv", space: SPACE, path: "", actions: ["tinycloud.kv/get"] }];

function recording(failure: Error) {
  const calls: unknown[][] = [];
  const tcw = { delegateTo: async (...args: unknown[]) => { calls.push(args); throw failure; } } as unknown as Pick<TinyCloudWeb, "delegateTo">;
  return { calls, delegate: frameGrantDelegate(tcw) };
}

describe("frame grants (TC-3568)", () => {
  test("every grant to a frame lasts one hour, can't be re-delegated and needs the space to exist", async () => {
    const { calls, delegate } = recording(new Error("node down"));
    await expect(delegate("did:key:z6MkFrame", entries)).rejects.toThrow("node down");
    expect(calls).toEqual([["did:key:z6MkFrame", entries, { expiry: 60 * 60 * 1000, disableSubDelegation: true, requireActivation: true }]]);
  });

  test("a space the node skipped surfaces as not hosted", async () => {
    const { delegate } = recording(new Error("skipped", { cause: { success: true, skipped: [SPACE] } }));
    const error = await delegate("did:key:z6MkFrame", entries).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpaceNotHostedError);
  });
});
