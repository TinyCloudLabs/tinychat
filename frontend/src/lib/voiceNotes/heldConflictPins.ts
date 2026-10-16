const conflicts = new Set<string>();

function pinKey(owner: string, sourceId: string): string {
  return `${owner}\u0000${sourceId}`;
}

/** Update the local conflict index read by the sourcePins.registerExtraPins predicate. */
export async function registerHeldConflictPin(owner: string, sourceId: string): Promise<void> {
  conflicts.add(pinKey(owner, sourceId));
}

export function hasHeldConflictPin(owner: string, sourceId: string): boolean {
  return conflicts.has(pinKey(owner, sourceId));
}

export function removeHeldConflictPin(owner: string, sourceId: string): void {
  conflicts.delete(pinKey(owner, sourceId));
}

export type ExtraPinRegistrar = (check: (owner: string, id: string) => boolean | Promise<boolean>) => () => void;

/** Connect this adapter to sourcePins.registerExtraPins once TC-1182 lands. */
export function connectHeldConflictPins(registerExtraPins: ExtraPinRegistrar): () => void {
  return registerExtraPins(hasHeldConflictPin);
}
