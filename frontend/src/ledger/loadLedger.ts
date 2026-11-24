import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { listKvKeys, parseKvValue } from "@/lib/shareRecords";
import { eventOrder, LEDGER_PREFIX, orderTime, SKEW, type LedgerRecord } from "./model";

/** Per task, and per task being checked, only the newest few events are read: an older one never wins the fold. */
const NEWEST_PER_GROUP = 5;
const CONCURRENT_READS = 8;

/** Which events could win the fold: `<folder>/<task>/<event>` or `<checker>/checks/<doer>/<task>/<event>` (one group per checker, so one agent cannot crowd out another's check). */
function groupAndOrder(key: string): { group: string; order: string } | null {
  const parts = key.slice(`${LEDGER_PREFIX}task/`.length).split("/");
  const file = parts.at(-1);
  const order = file ? eventOrder(file) : null;
  if (!order) return null;
  if (parts.length === 3) return { group: `${parts[0]}/${parts[1]}`, order };
  if (parts.length === 5 && parts[1] === "checks") return { group: `${parts[0]}/checks/${parts[2]}/${parts[3]}`, order };
  return null;
}

/**
 * Owner-session reads only; no write handle, grants, or catalog mutations. Lists every key, then reads only the newest
 * events of each task. An event that cannot be read is skipped; a ledger where nothing could be read is a failed load.
 */
export async function loadLedger(client: { kv: Pick<TinyCloudWeb["kv"], "list" | "get"> }, now = Date.now()): Promise<LedgerRecord[]> {
  const keys = [...new Set(await listKvKeys(client as Pick<TinyCloudWeb, "kv">, `${LEDGER_PREFIX}task/`))];
  const groups = new Map<string, { key: string; order: string }[]>();
  for (const key of keys) {
    const found = groupAndOrder(key);
    if (!found || orderTime(found.order) > now + SKEW) continue;
    const list = groups.get(found.group) ?? [];
    list.push({ key, order: found.order });
    groups.set(found.group, list);
  }
  const wanted: string[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0));
    for (const item of list.slice(0, NEWEST_PER_GROUP)) wanted.push(item.key);
  }
  const records: (LedgerRecord | null)[] = new Array(wanted.length).fill(null);
  let failed = 0;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENT_READS, wanted.length) }, async () => {
    while (next < wanted.length) {
      const index = next++;
      const key = wanted[index]!;
      try {
        const result = await client.kv.get(key, { source: "network" });
        if (result.ok) records[index] = { key, value: parseKvValue(result.data.data) };
        else failed++;
      } catch {
        failed++;
      }
    }
  }));
  if (wanted.length > 0 && failed === wanted.length) throw new Error("Could not read the ledger");
  return records.filter((record): record is LedgerRecord => record !== null);
}
