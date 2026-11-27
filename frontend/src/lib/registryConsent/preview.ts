// TC-3547: a space's plain name from its id, for the Settings "Where your data lives" rows.

const SPACE_ID = /^tinycloud:(?:[^:\s]+:){2,}([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/**
 * The space's plain name taken from its id (`tinycloud:pkh:eip155:1:0xabc:feed` is "Feed"). An id that does not end in a
 * name comes back whole, so nothing shows less than the record holds; `fallback` says that happened.
 */
export function spaceDisplayName(space: string): { name: string; fallback: boolean } {
  const match = SPACE_ID.exec(space);
  if (!match) return { name: space, fallback: true };
  const name = match[1]!;
  return { name: name.charAt(0).toUpperCase() + name.slice(1), fallback: false };
}
