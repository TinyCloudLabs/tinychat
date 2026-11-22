// The supervisor's secret-request routes on the gateway's control socket (only the supervisor reaches it):
//   PUT    /bots/<botId>/secrets/<id>  {name, sites, header, why, service?, ownerDid}
//            → 200 {approveUrl, expiresAt}; the same id while open → the same link; 400 malformed; 409 the owner
//              isn't this bot's owner, or the id is taken; 503 OpenKey or the sealed store can't be reached
//   POST   /bots/<botId>/secrets/drain  → 200 {outcomes: [{id, outcome: "approved", until} | {id, outcome}]}
//   DELETE /bots/<botId>/secrets/<id>  → 204: the request's key and grant are gone (Stop now, decline, expiry, end, retry)
// Without the sealing key (no dstack socket) every route answers 503: requests can't be kept, so none are made.

import { botIdFor } from "./owner";
import { parseAsk, type SecretGrants } from "./secret-grants";

export const SECRETS_ROUTE = /^\/bots\/([0-9a-f]{64})\/secrets\/([A-Za-z0-9_-]{1,64})$/;

/** `ownerOf` gives the id of the bot's owner's Main (the bot itself for Main). */
export async function secretRoute(req: Request, botId: string, id: string, grants: SecretGrants | undefined, ownerOf: (botId: string) => string): Promise<Response> {
  if (!grants) return new Response(null, { status: 503 });
  if (id === "drain") {
    if (req.method !== "POST") return new Response(null, { status: 405 });
    return Response.json({ outcomes: grants.drain(botId) });
  }
  if (req.method === "DELETE") {
    grants.remove(botId, id);
    return new Response(null, { status: 204 });
  }
  if (req.method !== "PUT") return new Response(null, { status: 405 });
  const ask = parseAsk(await req.json().catch(() => null));
  if (!ask) return new Response(null, { status: 400 });
  // The grant must come from this bot's own owner: Main's id is sha256 of the owner's DID.
  if (botIdFor(ask.ownerDid) !== ownerOf(botId)) return new Response(null, { status: 409 });
  const result = await grants.ask(botId, id, ask);
  if ("refused" in result) return new Response(null, { status: result.refused === "invalid" ? 400 : result.refused === "conflict" ? 409 : 503 });
  return Response.json(result);
}

