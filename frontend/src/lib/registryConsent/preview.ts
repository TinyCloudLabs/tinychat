// TC-3547: the rows of the consent, in plain words, from the SDK's preview. The SDK hands over a DID, a node DID, an origin
// and a space URI; the person sees an address, a host, a web address when it says more than the host, and a space name.
import type { RegistryPublishPreview } from "./adapter";
import { REGISTRY_CONSENT_COPY } from "./copy";

/** `0x…abcd`: the owner's address from their did:pkh, short. The SDK hands the whole DID. */
export function shortSubject(subject: string): string {
  const address = subject.slice(subject.lastIndexOf(":") + 1);
  return address.length > 4 ? `0x…${address.slice(-4)}` : address;
}

function parseOrigin(origin: string): URL | null {
  try { return new URL(origin); } catch { return null; }
}

/** The node's host name (`node.tinycloud.xyz`, no port); the origin as given if it is not a URL. */
export function serverHost(origin: string): string {
  return parseOrigin(origin)?.hostname ?? origin;
}

/**
 * The node's full web address, or null when it only repeats the host name: a plain https origin. A port, a path or
 * another scheme says more than the host name, so those stay.
 */
export function serverAddressBeyondHost(origin: string): string | null {
  const url = parseOrigin(origin);
  if (!url) return null;
  const full = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  return full === `https://${url.hostname}` ? null : full;
}

const SPACE_ID = /^tinycloud:(?:[^:\s]+:){2,}([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/**
 * The space's plain name taken from its id (`tinycloud:pkh:eip155:1:0xabc:feed` is "Feed"). An id that does not end in a
 * name comes back whole, so the consent never shows less than the record holds; `fallback` says that happened.
 */
export function spaceDisplayName(space: string): { name: string; fallback: boolean } {
  const match = SPACE_ID.exec(space);
  if (!match) return { name: space, fallback: true };
  const name = match[1]!;
  return { name: name.charAt(0).toUpperCase() + name.slice(1), fallback: false };
}

export interface PreviewRow { key: "subject" | "host" | "address" | "space"; label: string; value: string }

export function previewRows(preview: RegistryPublishPreview): PreviewRow[] {
  const labels = REGISTRY_CONSENT_COPY.previewLabels;
  const address = serverAddressBeyondHost(preview.nodeOrigin);
  return [
    { key: "subject", label: labels.subject, value: shortSubject(preview.subject) },
    { key: "host", label: labels.host, value: serverHost(preview.nodeOrigin) },
    ...(address ? [{ key: "address" as const, label: labels.address, value: address }] : []),
    { key: "space", label: labels.space, value: spaceDisplayName(preview.space).name },
  ];
}
