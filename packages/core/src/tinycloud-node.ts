/**
 * Origins that reach the same production TinyCloud node (one node DID, did:key:z6MkjHi79SMX4doJyo2w7jDTM6Fa7iX6EVZWXNbJ6RzBm3Wi):
 * node.tinycloud.xyz through Cloudflare, the default since TC-2923, and tee.node.tinycloud.xyz straight to the Phala
 * gateway, the default before it. Sessions, delegations and grants minted under either name are valid on the other.
 */
const PRODUCTION_NODE_ORIGINS: readonly string[] = ["https://node.tinycloud.xyz", "https://tee.node.tinycloud.xyz"];

/** The origin of a bare http(s) origin URL (an optional trailing slash); undefined for anything else. */
function originOf(host: string): string | undefined {
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    return undefined;
  }
  const bare = (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    && url.pathname === "/" && !url.search && !url.hash && (host === url.origin || host === `${url.origin}/`);
  return bare ? url.origin : undefined;
}

/** Whether two TinyCloud host URLs name the same node: the same origin, or both production node names. */
export function sameTinyCloudNode(a: string, b: string): boolean {
  const left = originOf(a);
  const right = originOf(b);
  if (left === undefined || right === undefined) return false;
  return left === right || (PRODUCTION_NODE_ORIGINS.includes(left) && PRODUCTION_NODE_ORIGINS.includes(right));
}
