export const SIBLING_BOT_KEY = /^[0-9a-f]{32}$/;

export function isBotKey(value: unknown): value is string {
  return typeof value === "string" && (value === "main" || SIBLING_BOT_KEY.test(value));
}

export async function botHistoryDirectory(address: string, botKey: string): Promise<string> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("history_owner_invalid");
  if (!isBotKey(botKey)) throw new Error("history_bot_key_invalid");
  const owner = `did:pkh:eip155:1:${address.toLowerCase()}`;
  const input = botKey === "main" ? owner : `${owner}\n${botKey}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const id = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  return `xyz.tinycloud.tinychat/threads/bots/v1/${id}/`;
}
