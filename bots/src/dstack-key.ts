// The one key the gateway takes from the CVM's key service (dstack KMS): the key that seals each secret request's
// record on the gateway volume, so the sealing key is never on a disk (Bobbie's review, 22 Nov). dstack derives it
// from the app id and the path; the same app gets the same key after a restart, another app (or a changed app id)
// gets another, and records sealed before then no longer open and end as "failed".
//
// Only GetKey on SEAL_KEY_PATH is ever sent (Naomi's ruling, 22 Nov 09:28Z). This module is not the boundary:
// anything running in the gateway can reach the socket. TC-3773 puts a proxy that enforces the path in front.

import { hkdfSync } from "node:crypto";

export const DSTACK_SOCKET = "/var/run/dstack.sock";
export const SEAL_KEY_PATH = "tinychat-bots/secret-seal";
const SEAL_KEY_INFO = "tinychat-bots secret-seal v1";
const GET_KEY_MS = 10_000;

type UnixInit = RequestInit & { unix: string };

/** 32 bytes for AES-256-GCM, derived from the dstack key with HKDF-SHA256. Throws when the key service can't answer. */
export async function sealKeyFromDstack(socket = DSTACK_SOCKET): Promise<Uint8Array> {
  const init: UnixInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: SEAL_KEY_PATH, purpose: "secret-seal" }),
    signal: AbortSignal.timeout(GET_KEY_MS),
    unix: socket,
  };
  const response = await fetch("http://dstack/GetKey", init);
  if (!response.ok) throw new Error(`dstack GetKey answered HTTP ${response.status}`);
  const body = (await response.json()) as { key?: unknown };
  if (typeof body.key !== "string" || !/^(0x)?[0-9a-f]{64,}$/i.test(body.key)) throw new Error("dstack GetKey returned no key");
  const material = Buffer.from(body.key.replace(/^0x/i, ""), "hex");
  return new Uint8Array(hkdfSync("sha256", material, new Uint8Array(0), SEAL_KEY_INFO, 32));
}
