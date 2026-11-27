// The keys the gateway takes from the CVM's key service (dstack KMS). dstack derives each from the app id and the
// path; the same app gets the same key after a restart, another app (or a changed app id) gets another.
//
// 1. The key that seals each secret request's record on the gateway volume, so the sealing key is never on a disk
//    (Bobbie's review, 22 Nov). Records sealed under another app id do not open and end as "failed".
// 2. The seed of the one stable "TinyCloud One" key that signs secret-request approval links, so OpenKey can show who
//    asks (TC-3772). It has its own path, so it is never derivable from the sealing key and the other way round.
//
// Only GetKey on these two paths is ever sent: SEAL_KEY_PATH (Naomi's ruling, 22 Nov 09:28Z) and
// APPROVAL_REQUESTER_PATH (Naomi's ruling, 25 Nov 21:30Z). This module is not the boundary: anything running in the
// gateway can reach the socket. TC-3773 puts a proxy that enforces the paths in front, so its allowlist is these two.

import { hkdfSync } from "node:crypto";

export const DSTACK_SOCKET = "/var/run/dstack.sock";
export const SEAL_KEY_PATH = "tinychat-bots/secret-seal";
export const APPROVAL_REQUESTER_PATH = "tinychat-bots/approval-requester";
const SEAL_KEY_INFO = "tinychat-bots secret-seal v1";
const APPROVAL_REQUESTER_INFO = "tinychat-bots approval-requester v1";
const GET_KEY_MS = 10_000;

type UnixInit = RequestInit & { unix: string };

/** One GetKey call: the raw key bytes for `path`. Throws when the key service can't answer. */
async function getKey(path: string, purpose: string, socket: string): Promise<Buffer> {
  const init: UnixInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, purpose }),
    signal: AbortSignal.timeout(GET_KEY_MS),
    unix: socket,
  };
  const response = await fetch("http://dstack/GetKey", init);
  if (!response.ok) throw new Error(`dstack GetKey answered HTTP ${response.status}`);
  const body = (await response.json()) as { key?: unknown };
  if (typeof body.key !== "string" || !/^(0x)?[0-9a-f]{64,}$/i.test(body.key)) throw new Error("dstack GetKey returned no key");
  return Buffer.from(body.key.replace(/^0x/i, ""), "hex");
}

/** 32 bytes for AES-256-GCM, derived from the dstack key with HKDF-SHA256. Throws when the key service can't answer. */
export async function sealKeyFromDstack(socket = DSTACK_SOCKET): Promise<Uint8Array> {
  const material = await getKey(SEAL_KEY_PATH, "secret-seal", socket);
  return new Uint8Array(hkdfSync("sha256", material, new Uint8Array(0), SEAL_KEY_INFO, 32));
}

/** The 32-byte Ed25519 seed of the stable approval requester, derived with HKDF-SHA256. Throws when the key service can't answer. */
export async function approvalRequesterSeedFromDstack(socket = DSTACK_SOCKET): Promise<Uint8Array> {
  const material = await getKey(APPROVAL_REQUESTER_PATH, "approval-requester", socket);
  return new Uint8Array(hkdfSync("sha256", material, new Uint8Array(0), APPROVAL_REQUESTER_INFO, 32));
}
