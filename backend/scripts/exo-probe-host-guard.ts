/**
 * Host guard for the TC-1013 real-node probe. The probe signs throwaway owner keys and writes to
 * the node it is pointed at, so it must only reach loopback unless the operator explicitly opts in.
 *
 * Accepted without the override: http or https, no userinfo, hostname exactly `127.0.0.1`,
 * `[::1]` or `localhost`. Everything else is refused before any network call. The override
 * (`EXO_PROBE_ALLOW_REMOTE_NODE=yes-i-know`) only relaxes the hostname check; scheme and userinfo
 * checks always apply.
 */
export const PROBE_REMOTE_OVERRIDE_VALUE = "yes-i-know";

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

export type ProbeHostCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkProbeNodeUrl(raw: string, overrideValue: string | undefined): ProbeHostCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "EXO_PROBE_NODE_URL is not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `EXO_PROBE_NODE_URL scheme ${url.protocol} is refused; use http or https` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "EXO_PROBE_NODE_URL must not contain userinfo" };
  }
  if (LOOPBACK_HOSTNAMES.has(url.hostname)) return { ok: true, url };
  if (overrideValue === PROBE_REMOTE_OVERRIDE_VALUE) return { ok: true, url };
  return {
    ok: false,
    reason: `EXO_PROBE_NODE_URL host "${url.hostname}" is not loopback (127.0.0.1, [::1], localhost). Set EXO_PROBE_ALLOW_REMOTE_NODE=${PROBE_REMOTE_OVERRIDE_VALUE} to probe a remote node.`,
  };
}
