// Card groups (docs/SPEC-card-groups.md): open cards that share a `group` file under one header in
// the Waiting and Asks lists. Pure, so placement and counts are tested without the DOM.

export type GroupEntry<T> = { kind: "card"; item: T } | { kind: "group"; name: string; items: T[] };

/** The group a card belongs to, or undefined. Only ask, approval and task records carry one. */
export function cardGroup(record: object): string | undefined {
  return "group" in record && typeof record.group === "string" && record.group !== "" ? record.group : undefined;
}

/**
 * Files open cards that share a group under one header, keeping the order the list already has.
 * A group sits at its highest-priority card (its first member in `items`), and its members keep
 * their relative order. A group with one open card renders as a plain card. Closed cards never join
 * a group, and they do not count towards one.
 */
export function groupCards<T>(items: readonly T[], groupOf: (item: T) => string | undefined, isOpen: (item: T) => boolean = () => true): GroupEntry<T>[] {
  const memberOf = (item: T): string | undefined => {
    const name = groupOf(item);
    return name !== undefined && isOpen(item) ? name : undefined;
  };
  const openCount = new Map<string, number>();
  for (const item of items) {
    const name = memberOf(item);
    if (name !== undefined) openCount.set(name, (openCount.get(name) ?? 0) + 1);
  }
  const entries: GroupEntry<T>[] = [];
  const groups = new Map<string, Extract<GroupEntry<T>, { kind: "group" }>>();
  for (const item of items) {
    const name = memberOf(item);
    if (name === undefined || (openCount.get(name) ?? 0) < 2) {
      entries.push({ kind: "card", item });
      continue;
    }
    let group = groups.get(name);
    if (group === undefined) {
      group = { kind: "group", name, items: [] };
      groups.set(name, group);
      entries.push(group);
    }
    group.items.push(item);
  }
  return entries;
}
