/** The backend tombstone must exist before the owner's copy can be removed. */
export async function deleteFirefliesWithLedger<T extends { ok: boolean }>(
  record: (source: string, id: string) => Promise<{ status: string }>,
  remove: () => Promise<T>,
  sourceId: string,
): Promise<T | { ok: false }> {
  const recorded = await record("fireflies", sourceId);
  if (recorded.status !== "ok") return { ok: false };
  return remove();
}
