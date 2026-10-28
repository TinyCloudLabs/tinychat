// Ported from tinycloud-agents eliza-service (ed320bd) so chat reads meetings through the hosted MCP.
/**
 * Combined meetings: one meeting is one candidate.
 *
 * A combined meeting is a `connector_meeting` row with `source = 'exo-merged'`. Its
 * `metadata.merge.members` lists the captures it was made from as exact `{source, source_id}`
 * pairs. The agent returns the combined row and not the captures it lists.
 *
 * Rules (the same as the TinyChat meeting corpus):
 * - A combined row is readable when `metadata` is valid JSON with a non-empty `merge.members`
 *   array in which every member has a non-empty text `source` and `source_id`.
 * - An unreadable combined row is left out of the list and hides nothing.
 * - Members come only from readable combined rows; matching is exact on both fields.
 * - A member whose source is `exo-merged` is never hidden.
 * - With no combined rows the list is returned unchanged.
 *
 * Interface:
 * - `combinedMemberKeys(rows)`: member keys of every readable combined row in `rows`.
 * - `partitionCombined(rows, project?)`: `{ visible, hiddenKeys }`; `visible` keeps the input order.
 * - `isCombinedMember(row, hiddenKeys, project?)`: true when the row is named by a combined row.
 * `project` maps a row to `{ source, sourceId, metadata }`, where `metadata` is the raw column
 * value (JSON text or a parsed object). Member keys must be computed from the raw column, so
 * callers that filter, page or decode rows should pass the combined rows to `combinedMemberKeys`
 * separately from the rows they list.
 *
 * Details: TC-1683
 */

export const COMBINED_SOURCE = "exo-merged";

export interface CombinedRowInput {
  source: unknown;
  sourceId: unknown;
  metadata?: unknown;
}

const identity = <T>(row: T) => row as unknown as CombinedRowInput;

/** Exact identity of a capture. Sources never contain `/`, so the first `/` splits the key. */
export function memberKey(source: string, sourceId: string): string {
  return `${source}/${sourceId}`;
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Member keys of a combined row, or null when the row is not readable as one. */
export function readCombinedMembers(metadata: unknown): string[] | null {
  let parsed: unknown = metadata;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const merge = (parsed as Record<string, unknown>).merge;
  if (!merge || typeof merge !== "object") return null;
  const members = (merge as Record<string, unknown>).members;
  if (!Array.isArray(members) || members.length === 0) return null;
  const keys: string[] = [];
  for (const member of members) {
    if (!member || typeof member !== "object" || Array.isArray(member)) return null;
    const { source, source_id: sourceId } = member as Record<string, unknown>;
    if (!nonEmptyText(source) || !nonEmptyText(sourceId)) return null;
    keys.push(memberKey(source, sourceId));
  }
  return keys;
}

/** Keys of every capture named by a readable combined row. `exo-merged` members are skipped. */
export function combinedMemberKeys<T>(rows: readonly T[], project: (row: T) => CombinedRowInput = identity): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    const input = project(row);
    if (input.source !== COMBINED_SOURCE) continue;
    const members = readCombinedMembers(input.metadata);
    if (!members) continue;
    for (const key of members) if (!key.startsWith(`${COMBINED_SOURCE}/`)) keys.add(key);
  }
  return keys;
}

/** True when the row is a capture named by a readable combined row. */
export function isCombinedMember<T>(row: T, hiddenKeys: ReadonlySet<string>, project: (row: T) => CombinedRowInput = identity): boolean {
  const { source, sourceId } = project(row);
  return nonEmptyText(source) && nonEmptyText(sourceId) && source !== COMBINED_SOURCE && hiddenKeys.has(memberKey(source, sourceId));
}

/** Splits rows into the ones the agent returns and the member keys that were removed. */
export function partitionCombined<T>(rows: readonly T[], project: (row: T) => CombinedRowInput = identity): { visible: T[]; hiddenKeys: Set<string> } {
  const hiddenKeys = combinedMemberKeys(rows, project);
  const visible = rows.filter(row => {
    const input = project(row);
    if (input.source === COMBINED_SOURCE && readCombinedMembers(input.metadata) === null) return false;
    return !isCombinedMember(row, hiddenKeys, project);
  });
  return { visible, hiddenKeys };
}
