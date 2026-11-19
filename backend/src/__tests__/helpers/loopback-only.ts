/**
 * For tests that must stay on this machine. Wraps `fetch` so that a request to anything but 127.0.0.1 is refused
 * and recorded instead of sent. A client library may contact a host of its own choosing; this is how a test finds out.
 */
export function loopbackOnly(inner: typeof fetch): { fetch: typeof fetch; refused: string[] } {
  const refused: string[] = [];
  const guarded = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const address = input instanceof Request ? input.url : String(input);
    let host: string;
    try {
      host = new URL(address).hostname;
    } catch {
      host = address;
    }
    if (host !== "127.0.0.1") {
      refused.push(host);
      throw new Error(`request left this machine: ${host}`);
    }
    return inner(input, init);
  }) as typeof fetch;
  return { fetch: guarded, refused };
}
