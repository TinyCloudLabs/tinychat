/**
 * OpenKey admits `apps/<id>/` key grants only when the manifest it fetches from
 * https://tinycloud.chat/.well-known/openkey-manifest.json has the same canonical SHA-256 as the
 * `manifestDigest` the SDK sends. This computes both sides offline: the SDK's own digest (the
 * authorization class's `buildPresentationEnvelope`, pinned at the same version as web-sdk) for the
 * manifest the web client loads from that file, and OpenKey's canonicalisation (sorted-key JSON,
 * apps/api/src/services/manifest-origin-fetch.ts `canonicalizeManifestJson`) of the served bytes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { NodeUserAuthorization } from "@tinycloud/node-sdk/core";
import { loadManifest, type Manifest } from "@tinycloud/sdk-core";

const SERVED = new URL("../../../frontend/public/.well-known/openkey-manifest.json", import.meta.url);
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface PresentationEnvelopeSource {
  buildPresentationEnvelope(reason?: string): { manifestDigest?: string } | undefined;
}

/**
 * `buildPresentationEnvelope` reads only `_manifest`, so the digest is taken from the real method
 * without constructing a signer or a node connection.
 */
function sdkEnvelopeFor(manifest: Manifest): { manifestDigest?: string } | undefined {
  const authorization: PresentationEnvelopeSource = Object.assign(
    Object.create(NodeUserAuthorization.prototype) as PresentationEnvelopeSource,
    { _manifest: manifest },
  );
  return authorization.buildPresentationEnvelope();
}

/** OpenKey's `canonicalizeManifestJson` + `canonicalManifestSha256Hex`: JSON round trip, then sorted keys at every level. */
function openKeyCanonicalSha256(bytes: Uint8Array): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  };
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(parsed)))).digest("hex");
}

describe("the served OpenKey manifest and the SDK digest", () => {
  test("the digest the SDK sends for the manifest the web client loads equals OpenKey's digest of the served bytes", async () => {
    const bytes = readFileSync(SERVED);
    globalThis.fetch = (async () => new Response(bytes, { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const manifest = await loadManifest("/.well-known/openkey-manifest.json");
    expect(manifest.keys_app_id).toBe("chat.tinycloud.tinychat");

    const envelope = sdkEnvelopeFor(manifest);
    expect(envelope?.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope?.manifestDigest).toBe(openKeyCanonicalSha256(bytes));
  });

  test("a manifest that differs from the served file has a different digest", () => {
    const bytes = readFileSync(SERVED);
    const changed = { ...(JSON.parse(bytes.toString("utf8")) as Record<string, unknown>), keys: [] };
    expect(openKeyCanonicalSha256(new TextEncoder().encode(JSON.stringify(changed)))).not.toBe(openKeyCanonicalSha256(bytes));
  });
});
