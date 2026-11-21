import { randomUUID } from "node:crypto";

import { RESPONSE_LIMITS, tenantRefFor, type PtxClient } from "./private-cloud-transcription.js";
import { TRANSCRIPTION_ID_RE } from "./private-cloud-transcription-dto.js";

/**
 * TC-3166: account deletion also clears the account's private cloud transcription jobs (Exo voice notes and
 * uploads). TinyChat keeps no index of them, so the list is PTX's own, scoped by the tenant ref (an HMAC of the
 * address). PTX's DELETE cancels an active job, hides it from every read and deletes its transcript in one
 * transaction; the audio file is removed afterwards by PTX's own file ledger. The read-back is the list itself:
 * it must come back empty, and a job that was deleted but is listed again is a failure, never "gone".
 *
 * Idempotent: a 404 is a job that is already gone, and a second run over an empty account lists nothing.
 */

/** The page the relay already reads safely under its response limit. */
const PAGE_SIZE = 50;
/** Lists per run: bounds one request to 2,000 jobs; a larger backlog is finished by the retry. */
const MAX_ROUNDS = 40;
const DELETE_CONCURRENCY = 4;

export type PrivateCloudPurgeReason = "list_off_contract" | "list_failed" | "delete_failed" | "not_drained";

export class PrivateCloudPurgeError extends Error {
  constructor(readonly reason: PrivateCloudPurgeReason) {
    super(`private_cloud_purge_${reason}`);
    this.name = "PrivateCloudPurgeError";
  }
}

export interface PrivateCloudPurger {
  /** Deletes every job this address holds and proves the list is empty. Resolves to how many it deleted. */
  purge(address: string): Promise<number>;
}

function jobIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) return null;
  const ids: string[] = [];
  for (const job of body.data as unknown[]) {
    if (typeof job !== "object" || job === null || !("id" in job) || typeof job.id !== "string" || !TRANSCRIPTION_ID_RE.test(job.id)) return null;
    ids.push(job.id);
  }
  return ids;
}

export function createPrivateCloudPurger(client: PtxClient, tenantKey: string): PrivateCloudPurger {
  return {
    async purge(address) {
      const tenantRef = tenantRefFor(tenantKey, address);
      const correlationId = randomUUID();

      async function list(): Promise<string[]> {
        const response = await client.request({
          method: "GET",
          path: `/v1/transcriptions?limit=${PAGE_SIZE}`,
          correlationId,
          maxBytes: RESPONSE_LIMITS.list,
          tenantRef,
        });
        if (response.status !== 200) throw new PrivateCloudPurgeError("list_failed");
        const ids = jobIds(response.body);
        if (ids === null || ids.length > PAGE_SIZE) throw new PrivateCloudPurgeError("list_off_contract");
        return ids;
      }

      async function remove(id: string): Promise<boolean> {
        const response = await client.request({
          method: "DELETE",
          path: `/v1/transcriptions/${id}`,
          correlationId,
          maxBytes: RESPONSE_LIMITS.delete,
          tenantRef,
        });
        return response.status === 200 || response.status === 204 || response.status === 404;
      }

      const deleted = new Set<string>();
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const listed = await list();
        if (listed.length === 0) return deleted.size;
        // Deleted last round and listed again: PTX answered success but did not drop it.
        if (listed.every((id) => deleted.has(id))) throw new PrivateCloudPurgeError("not_drained");
        let failed = false;
        let cursor = 0;
        const worker = async (): Promise<void> => {
          while (cursor < listed.length) {
            const id = listed[cursor++]!;
            if (await remove(id)) deleted.add(id);
            else failed = true;
          }
        };
        await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, listed.length) }, worker));
        if (failed) throw new PrivateCloudPurgeError("delete_failed");
      }
      throw new PrivateCloudPurgeError("not_drained");
    },
  };
}
