// Pure, browser-safe RTMR3 replay for the backend self-attestation event log.
//
// The served `event_log` is a JSON string of an array of TDX measurement
// events. We replay the imr-3 events to reproduce the RTMR3 value that is
// baked into the Intel-signed quote body, proving the served event log is the
// one that was measured.
//
// Ground truth (REAL prod capture, 2026-06-11): all imr-3 events carry an
// EMPTY `digest`, so the per-event digest is derived as
//   sha384( uint32LE(event_type) || ":" || utf8(event) || ":" || hexDecode(event_payload) )
// then chained as mr = sha384(mr || digest) starting from 48 zero bytes, in
// order. Events that already carry a non-empty `digest` use it as-is.
//
// Browser-only constraints: crypto.subtle SHA-384, async, Uint8Array only —
// NO node Buffer.

export interface EventLogEntry {
  imr: number;
  event_type: number;
  digest: string;
  event: string;
  event_payload: string;
}

const COLON = 0x3a;

/** Parse the served event_log JSON string into its event array. */
export function parseEventLog(eventLogJson: string): EventLogEntry[] {
  const parsed = JSON.parse(eventLogJson);
  if (!Array.isArray(parsed)) {
    throw new Error("event_log is not a JSON array");
  }
  return parsed as EventLogEntry[];
}

// Pin the backing buffer to ArrayBuffer (not the SharedArrayBuffer union) so
// crypto.subtle.digest accepts these as BufferSource under strict lib types.
type Bytes = Uint8Array<ArrayBuffer>;

function hexDecode(hex: string): Bytes {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`odd-length hex string: ${hex}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function uint32LE(value: number): Bytes {
  const out = new Uint8Array(4);
  const v = value >>> 0;
  out[0] = v & 0xff;
  out[1] = (v >>> 8) & 0xff;
  out[2] = (v >>> 16) & 0xff;
  out[3] = (v >>> 24) & 0xff;
  return out;
}

function concatBytes(parts: Uint8Array[]): Bytes {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function sha384(bytes: Bytes): Promise<Bytes> {
  const digest = await crypto.subtle.digest("SHA-384", bytes);
  return new Uint8Array(digest);
}

/**
 * Derive the per-event digest for a single event. Empty `digest` ⇒ derive from
 * (event_type, name, payload); non-empty `digest` ⇒ use it verbatim.
 */
async function eventDigest(entry: EventLogEntry): Promise<Bytes> {
  if (entry.digest && entry.digest.length > 0) {
    return hexDecode(entry.digest);
  }
  const name = new TextEncoder().encode(entry.event);
  const payload = hexDecode(entry.event_payload);
  const preimage = concatBytes([
    uint32LE(entry.event_type),
    Uint8Array.of(COLON),
    name,
    Uint8Array.of(COLON),
    payload,
  ]);
  return sha384(preimage);
}

/**
 * Replay RTMR3 from the served event_log. Returns the replayed measurement as
 * lowercase hex WITHOUT a 0x prefix (the quote body's rtmr3 is `0x` + 96 hex;
 * strip the prefix before comparing).
 */
export async function replayRtmr3(eventLogJson: string): Promise<string> {
  const events = parseEventLog(eventLogJson).filter((e) => e.imr === 3);
  let mr = new Uint8Array(48); // 48 zero bytes
  for (const entry of events) {
    const digest = await eventDigest(entry);
    mr = await sha384(concatBytes([mr, digest]));
  }
  return hexEncode(mr);
}

/**
 * Extract the compose-hash event payload (the sha256 of the app-compose
 * envelope) from the imr-3 events. Returns null if no such event is present.
 */
export function extractComposeHashEvent(eventLogJson: string): string | null {
  const events = parseEventLog(eventLogJson);
  const entry = events.find((e) => e.imr === 3 && e.event === "compose-hash");
  return entry ? entry.event_payload : null;
}
