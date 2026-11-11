// Native ceiling guard (TC-2720, TC-1989): pushes the exact authorization request
// native sign-in builds from manifest.json to production OpenKey, the only place
// the TinyCloud Home native client's ceiling lives. OpenKey refuses the whole
// request if one entry is outside the ceiling, which is how #583 broke every
// iOS and Android sign-in. The request is a throwaway PAR with a fresh session
// key and PKCE pair; nothing is signed and the request URI expires in 90s.
//
// Exit 1: OpenKey refused the request (a manifest or native-request change needs
// the ceiling widened first). Exit 0 with a warning: production was unreachable
// or answered 5xx/429, which says nothing about this change.
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Manifest } from "@tinycloud/sdk-core";
import APP_MANIFEST from "../../manifest.json";
import { nativePermissions } from "../src/lib/openkeyNative";

const env = Object.fromEntries(readFileSync(new URL("../.env.production", import.meta.url), "utf8").split("\n")
  .map((line) => line.trim()).filter((line) => line && !line.startsWith("#") && line.includes("="))
  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const clientId = env.VITE_OPENKEY_NATIVE_CLIENT_ID;
const host = new URL(env.VITE_OPENKEY_HOST ?? "https://openkey.so");
if (!clientId) throw new Error("frontend/.env.production has no VITE_OPENKEY_NATIVE_CLIENT_ID");
host.hostname = `api.${host.hostname}`;
const par = `${host.origin}/api/auth/oauth2/par`;

function unreachable(detail: string): never {
  console.log(`::warning title=Native ceiling check skipped::Production OpenKey was unreachable (${detail}); the native request was not checked.`);
  process.exit(0);
}

const permissions = nativePermissions(APP_MANIFEST as unknown as Manifest);
const { x } = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
const form = new URLSearchParams({
  client_id: clientId,
  response_type: "code",
  redirect_uri: "xyz.tinycloud.exo://openkey/callback",
  state: randomBytes(16).toString("base64url"),
  code_challenge: createHash("sha256").update(randomBytes(32).toString("base64url")).digest("base64url"),
  code_challenge_method: "S256",
  scope: "openid offline_access tinycloud:delegation",
  authorization_details: JSON.stringify([{ type: "tinycloud_delegation", session_key: { kty: "OKP", crv: "Ed25519", x }, permissions }]),
});

let response: Response;
try {
  response = await fetch(par, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(20_000) });
} catch (error) {
  unreachable(error instanceof Error ? error.message : "network error");
}
const body = await response.text();
if (response.status >= 500 || response.status === 429) unreachable(`HTTP ${response.status}`);
if (response.status !== 201) {
  console.log(`::error title=Native sign-in would fail::OpenKey refused the native request from manifest.json: HTTP ${response.status} ${body.slice(0, 300)}`);
  console.log("Widen the TinyCloud Home native client's ceiling (openkey docs/native-tinycloud-delegation.md) before shipping this manifest or native-request change.");
  for (const permission of permissions) console.log(`  ${permission.service} ${permission.path || '""'} ${permission.actions.join(",")}`);
  process.exit(1);
}
console.log(`OpenKey accepted the native request from manifest.json (${permissions.length} entries, HTTP 201).`);
