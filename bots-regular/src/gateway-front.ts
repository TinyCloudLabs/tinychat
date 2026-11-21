// The model gateway from bots/ (Gateway), served over TCP with the bot id in the path, plus its control API.
//
//   sandboxes  ANY    /bots/<botId>/v1/...   forwarded to Gateway.handle(botId) as /v1/...
//   service    PUT    /bots/<botId>          {"token": "<64 hex>", "owner": "<64 hex>"}   on the control socket
//              DELETE /bots/<botId>
//              GET    /bots/<botId>/receipts

import type { Gateway } from "../../bots/src/gateway";
import { isRecord } from "../../bots/src/guards";
import { BOT_ID } from "../../bots/src/owner";

const BOT_PATH = /^\/bots\/([0-9a-f]{64})(\/v1\/.*)$/;

/** The TCP handler. `streaming` lifts the server's idle timeout once a call is accepted. */
export function sandboxFetch(gateway: Pick<Gateway, "handle">) {
  return (req: Request, streaming: () => void = () => {}): Promise<Response> | Response => {
    const url = new URL(req.url);
    const match = BOT_PATH.exec(url.pathname);
    if (!match) return new Response(null, { status: 404 });
    return gateway.handle(match[1]!, new Request(new URL(`${match[2]}${url.search}`, url.origin).href, req), streaming);
  };
}

/** The control socket's handler. */
export function controlFetch(gateway: Pick<Gateway, "setToken" | "dropToken">, receipts?: (botId: string) => unknown[]) {
  return async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const receiptMatch = /^\/bots\/([0-9a-f]{64})\/receipts$/.exec(path);
    if (req.method === "GET" && receiptMatch) return Response.json(receipts?.(receiptMatch[1]!) ?? []);
    const match = /^\/bots\/([0-9a-f]{64})$/.exec(path);
    if (!match) return new Response(null, { status: 404 });
    const botId = match[1]!;
    if (req.method === "DELETE") {
      gateway.dropToken(botId);
      return new Response(null, { status: 204 });
    }
    if (req.method !== "PUT") return new Response(null, { status: 405 });
    const body: unknown = await req.json().catch(() => null);
    if (!isRecord(body) || typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token)
      || (body.owner !== undefined && (typeof body.owner !== "string" || !BOT_ID.test(body.owner)))) {
      return new Response(null, { status: 400 });
    }
    gateway.setToken(botId, body.token, body.owner as string | undefined);
    return new Response(null, { status: 204 });
  };
}

/** The service's client for the control socket. */
export interface GatewayControl {
  register(botId: string, token: string, ownerId: string): Promise<void>;
  drop(botId: string): Promise<void>;
  receipts(botId: string): Promise<unknown>;
}

export function socketGatewayControl(socketPath: string): GatewayControl {
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://gateway${path}`, {
      method,
      unix: socketPath,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`gateway control ${method} failed: ${response.status}`);
    return response;
  };
  return {
    register: async (botId, token, owner) => { await call("PUT", `/bots/${botId}`, { token, owner }); },
    drop: async botId => { await call("DELETE", `/bots/${botId}`); },
    receipts: async botId => (await call("GET", `/bots/${botId}/receipts`)).json(),
  };
}
