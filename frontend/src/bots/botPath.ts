// A bot's address in the Bots view (TC-3325): /chat/bot/<key>, where the key is `main` or 32 lower-case hex digits.
// The shell's routes (shell/routes.ts) already send any /chat/... address to the Chat slot; this file only reads the
// bot out of it. /chat itself, or an address naming no bot the account has, opens the bot shown last, else Main.
import { PATHS } from "@/shell/routes";

const PREFIX = `${PATHS.chat}/bot/`;
const KEY = /^(?:main|[0-9a-f]{32})$/;
const LAST_BOT_KEY_PREFIX = "tinychat:last-bot:v1:";

/** The bot key an address names, or null when it names none. */
export function botKeyFromPath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const key = pathname.slice(PREFIX.length).replace(/\/$/, "");
  return KEY.test(key) ? key : null;
}

export function botPath(key: string): string {
  if (!KEY.test(key)) throw new Error("bot_key_invalid");
  return `${PREFIX}${key}`;
}

/** The bot this account last had open on this device, if any. */
export function readLastBot(account: string): string | null {
  try {
    const key = window.localStorage.getItem(`${LAST_BOT_KEY_PREFIX}${account.toLowerCase()}`);
    return key && KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

export function saveLastBot(account: string, key: string): void {
  if (!KEY.test(key)) return;
  try {
    window.localStorage.setItem(`${LAST_BOT_KEY_PREFIX}${account.toLowerCase()}`, key);
  } catch {
    // Storage is full or blocked: /chat then opens Main.
  }
}

/**
 * The bot to show for an address: the one it names when the account has it, else the bot shown last when the
 * account still has it, else Main. `has` says whether a key is one of the account's bots in the list.
 */
export function botForPath(pathname: string, account: string | null, has: (key: string) => boolean): string {
  const named = botKeyFromPath(pathname);
  if (named && has(named)) return named;
  const last = account ? readLastBot(account) : null;
  return last && has(last) ? last : "main";
}
