// The gateway's half of an account erase: POST /owners/<did>/erase {"keys": [...]} on the control socket, which only
// the supervisor can reach. `keys` are the owner's sibling bot keys; Main and Courier's bot follow from the DID. The
// answer is 200 {"outcome":"gone"} once every ledger, token, listener, sealed secret and Courier store of the owner is
// gone from the gateway, else 503 {"outcome":"failed"} and the supervisor calls again. It repeats safely, and it
// answers with no owner data.
import type { Gateway } from "./gateway";
import { isRecord } from "./guards";
import { BOT_KEY, botIdFor, OWNER_DID } from "./owner";
import { courierBotId } from "./courier/bot-id";

export const OWNER_ERASE_ROUTE = /^\/owners\/([^/]+)\/erase$/;
const MAX_KEYS = 64;

export interface OwnerEraseDeps {
  gateway: Pick<Gateway, "eraseBots" | "ownedBots">;
  /** Stops a bot's listener, drops its token and removes its egress directory. */
  unlisten(botId: string): void;
  /** Drops what the verified-fetch receipts hold for a bot. */
  forgetReceipts?(botId: string): void;
  /** Set when the gateway has no secret grants open (the key service was down at start): removes sealed requests by bot id. */
  eraseSealed?(botIds: readonly string[]): void;
  /** The owner's Courier state, whichever way the gateway holds it. Throws unless it is all gone. */
  eraseCourier(owner: string): Promise<void>;
}

const answer = (status: number, outcome: "gone" | "failed") => Response.json({ outcome }, { status });

export async function ownerErase(req: Request, route: RegExpExecArray, deps: OwnerEraseDeps): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let owner: string;
  try { owner = decodeURIComponent(route[1]!); } catch { return new Response(null, { status: 400 }); }
  const body: unknown = await req.json().catch(() => null);
  const keys = isRecord(body) ? body.keys : undefined;
  if (!OWNER_DID.test(owner) || !Array.isArray(keys) || keys.length > MAX_KEYS
    || !keys.every((key): key is string => typeof key === "string" && BOT_KEY.test(key))) {
    return new Response(null, { status: 400 });
  }
  // Every step runs over the bots the gateway's owner map names for the owner too, so a sibling the manifest lost goes as well.
  try {
    const ids = deps.gateway.ownedBots([botIdFor(owner), ...[...new Set(keys)].map(key => botIdFor(owner, key)), courierBotId(owner)]);
    for (const id of ids) {
      deps.unlisten(id);
      deps.forgetReceipts?.(id);
    }
    deps.eraseSealed?.(ids);
    // Both halves run, so one retry has less left to do.
    const ledgers = deps.gateway.eraseBots(ids);
    await deps.eraseCourier(owner);
    return answer(ledgers ? 200 : 503, ledgers ? "gone" : "failed");
  } catch {
    return answer(503, "failed");
  }
}
