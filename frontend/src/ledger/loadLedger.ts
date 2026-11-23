import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { listKvKeys, parseKvValue } from "@/lib/shareRecords";
import { LEDGER_PREFIX, type LedgerRecord } from "./model";

/** Owner-session reads only; no write handle, grants, or catalog mutations. */
export async function loadLedger(client: Pick<TinyCloudWeb, "kv">): Promise<LedgerRecord[]> {
  const keys = [...new Set(await listKvKeys(client, `${LEDGER_PREFIX}task/`))];
  const records: LedgerRecord[] = new Array(keys.length);
  let next = 0;
  // Bound concurrent full-history reads rather than issuing one request per event at once.
  await Promise.all(Array.from({ length: Math.min(8, keys.length) }, async () => {
    while (next < keys.length) {
      const index = next++;
      const key = keys[index]!;
      const result = await client.kv.get(key, { source: "network" });
      if (!result.ok) throw new Error("Could not read the ledger");
      records[index] = { key, value: parseKvValue(result.data.data) };
    }
  }));
  return records;
}
