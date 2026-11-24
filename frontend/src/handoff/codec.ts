const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LINK_PREFIX = "https://tinycloud.one/handoff#tch1";
const SEED_BYTES = 32;

export function decodeHandoffFragment(fragment: string): { seed: Uint8Array; authorization: string } {
  const invalid = () => new Error("Invalid handoff link");
  const encoded = fragment.slice("#tch1".length);
  const length = Math.floor(encoded.length * 5 / 8);
  if (!fragment.startsWith("#tch1") || LINK_PREFIX.length + encoded.length > 1800 ||
      length <= SEED_BYTES || Math.ceil(length * 8 / 5) !== encoded.length) throw invalid();

  const bytes = new Uint8Array(length);
  try {
    let tail = 0;
    let bits = 0;
    let offset = 0;
    for (const character of encoded) {
      const digit = ALPHABET.indexOf(character);
      if (digit < 0) throw invalid();
      tail = (tail << 5) | digit;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        bytes[offset++] = tail >> bits;
        tail &= (1 << bits) - 1;
      }
    }
    if (tail !== 0) throw invalid();
    const authorization = new TextDecoder().decode(bytes.subarray(SEED_BYTES));
    if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(authorization)) throw invalid();
    // Decoding must preserve the original ASCII bytes, including rejecting a UTF-8 BOM.
    if (authorization.length !== length - SEED_BYTES) throw invalid();
    return { seed: bytes.slice(0, SEED_BYTES), authorization };
  } finally {
    bytes.fill(0);
  }
}
