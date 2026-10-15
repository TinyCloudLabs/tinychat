import { APP_ID } from "@tinyboilerplate/core";
import { makePkhSpaceId } from "@tinycloud/node-sdk/core";
import { parseVerifiedRecapFromSiwe } from "@tinycloud/node-sdk-wasm";
import { isCanonicalResourcePath } from "./portable-delegation.js";

const APP_PATH_PREFIX = `${APP_ID}/`;
const KV_ACTIONS: readonly string[] = ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list", "tinycloud.kv/metadata"];
const SQL_ACTIONS: readonly string[] = ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/schema"];

/** OpenKey signs a session DID as URI, so its app audience lives in signed ReCap paths.
 * The registered native client's ceiling confines KV/SQL grants to this app ID. */
export function hasTinyChatNativeAudience(message: string, address: string, chainId: number, resources?: string[]): boolean {
  // The WASM parser reads only the final resource. Refuse mixed-resource SIWEs.
  if (chainId !== 1 || resources?.length !== 1 || !resources[0].startsWith("urn:recap:")) return false;
  let entries: unknown;
  try {
    entries = parseVerifiedRecapFromSiwe(message);
  } catch {
    return false;
  }
  if (!Array.isArray(entries)) return false;
  const space = makePkhSpaceId(address, 1, "applications").toLowerCase();
  let appGrant = false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" ||
      typeof entry.service !== "string" || typeof entry.space !== "string" ||
      typeof entry.path !== "string" || !Array.isArray(entry.actions) ||
      entry.space.toLowerCase() !== space) return false;
    if (entry.service === "capabilities" && entry.path === "" &&
      entry.actions.length === 1 && entry.actions[0] === "tinycloud.capabilities/read") continue;
    if ((entry.service !== "kv" && entry.service !== "sql") ||
      !entry.path.startsWith(APP_PATH_PREFIX) || !isCanonicalResourcePath(entry.path) ||
      !/^[A-Za-z0-9._~@+=,:/-]+$/.test(entry.path) || entry.actions.length === 0) return false;
    const allowedActions = entry.service === "kv" ? KV_ACTIONS : SQL_ACTIONS;
    for (const action of entry.actions) {
      if (typeof action !== "string" || !allowedActions.includes(action)) return false;
    }
    appGrant = true;
  }
  return appGrant;
}
