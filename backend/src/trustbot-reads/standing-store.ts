import { assertKvResult, isKvMissingKeyResult, withSessionRefresh } from "@tinyboilerplate/server";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { isKvPreconditionFailed } from "../exo/activated-grant.js";
import type { StandingMetadataStore, StandingReadMetadata } from "./standing-controller.js";

const PREFIX = "trustbot/standing-read-approvals/";

export function backendStandingMetadataStore(node: TinyCloudNode): StandingMetadataStore {
  return {
    async read(owner) {
      const key = PREFIX + owner;
      return withSessionRefresh(node, async () => {
        const result = await node.kv.get<string>(key, { source: "network", maxResponseBytes: 128 * 1024 });
        if (isKvMissingKeyResult(result, key)) return { state: { generation: 0 } };
        assertKvResult(result);
        if (!result.ok) throw new Error("standing_read_metadata_unavailable");
        const { headers, data } = result.data;
        const version = headers?.etag;
        if (typeof data !== "string" || !version || version.startsWith("W/")) throw new Error("standing_read_metadata_invalid");
        const state = JSON.parse(data) as StandingReadMetadata;
        if (!state || !Number.isSafeInteger(state.generation) || state.generation < 1) throw new Error("standing_read_metadata_invalid");
        return { state, version };
      });
    },
    async write(owner, state, version) {
      return withSessionRefresh(node, async () => {
        const condition = version === undefined ? { ifNoneMatch: "*" as const } : { ifMatch: version };
        const result = await node.kv.put(PREFIX + owner, JSON.stringify(state), condition);
        if (isKvPreconditionFailed(result)) return false;
        assertKvResult(result);
        return true;
      });
    },
    async *owners() {
      let cursor: string | undefined;
      do {
        const result = await withSessionRefresh(node, async () => assertKvResult(await node.kv.list({ prefix: PREFIX, cursor })));
        if (!result.ok) throw new Error("standing_read_metadata_unavailable");
        for (const key of result.data.keys) {
          const owner = key.slice(PREFIX.length);
          if (key.startsWith(PREFIX) && /^did:pkh:eip155:1:0x[a-f0-9]{40}$/.test(owner)) yield owner;
        }
        cursor = result.data.nextCursor;
        if (result.data.truncated && !cursor) throw new Error("standing_read_metadata_pagination_unavailable");
      } while (cursor);
    },
  };
}
