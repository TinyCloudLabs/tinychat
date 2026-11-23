import { AGENT_GRANT, DEFAULT_HOST } from "@tinycloud/courier";
import { isRecord } from "../guards";
import { OWNER_DID } from "../owner";
import { InvalidCourierGrant, type CourierGrantStore } from "./grant-store";
import { courierIdentity } from "./identity";

/** Only the supervisor can reach this socket; owner comes from its verified signed call. */
export function createCourierControl(grants: CourierGrantStore) {
  return async (req: Request): Promise<Response | undefined> => {
    const match = /^\/courier\/([^/]+)\/(identity|grant)$/.exec(new URL(req.url).pathname);
    if (!match) return undefined;
    let owner: string;
    try { owner = decodeURIComponent(match[1]!); } catch { return new Response(null, { status: 400 }); }
    if (!OWNER_DID.test(owner)) return new Response(null, { status: 400 });
    try {
      if (match[2] === "identity") {
        if (req.method !== "GET") return new Response(null, { status: 405 });
        const identity = await courierIdentity(owner);
        return Response.json({ did: identity.did, publicJwk: identity.publicJwk, request: { host: DEFAULT_HOST, permissions: AGENT_GRANT, expiry: "30d" } });
      }
      if (req.method === "GET") return Response.json({ expiresAt: (await grants.get(owner))?.expiresAt ?? null });
      if (req.method === "DELETE") { await grants.delete(owner); return new Response(null, { status: 204 }); }
      if (req.method !== "PUT") return new Response(null, { status: 405 });
      const input: unknown = await req.json().catch(() => null);
      if (!isRecord(input) || !("raw" in input) || typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt)) return new Response(null, { status: 400 });
      await grants.put(owner, { raw: input.raw, expiresAt: input.expiresAt });
      return Response.json({ expiresAt: input.expiresAt });
    } catch (error) {
      return new Response(null, { status: error instanceof InvalidCourierGrant ? 400 : 503 });
    }
  };
}
