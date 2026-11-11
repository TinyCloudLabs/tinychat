const WEB_SIGN_OUT_PENDING_KEY = "xyz.tinycloud.tinychat:signout-pending";

type Fence = { token: string; address: string | null };

function readFence(): Fence | null {
  try {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    const value = storage?.getItem(WEB_SIGN_OUT_PENDING_KEY);
    if (value == null) return null;
    const separator = value.indexOf("|");
    return separator < 0
      ? { token: value, address: null }
      : { token: value.slice(0, separator), address: value.slice(separator + 1) || null };
  } catch {
    return { token: "", address: null };
  }
}

/** Persist a global restore fence synchronously before asynchronous sign-out work. */
export function setWebSignOutPending(address: string): string | null {
  try {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    if (!storage) return null;
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    storage.setItem(WEB_SIGN_OUT_PENDING_KEY, `${token}|${address.toLowerCase()}`);
    return readFence()?.token === token ? token : null;
  } catch {
    return null;
  }
}

/** Storage errors fail closed: an unreadable fence must never permit credential restore. */
export function hasWebSignOutPending(address?: string): boolean {
  const fence = readFence();
  if (!fence) return false;
  return !address || !fence.address || fence.address === address.toLowerCase();
}

export function webSignOutPendingAddress(): string | null {
  return readFence()?.address ?? null;
}

/** Remove only this sign-out's fence; a newer sign-out token must survive late cleanup. */
export function clearWebSignOutPending(address?: string, expectedToken?: string): boolean {
  try {
    const storage = typeof window === "undefined" ? undefined : window.localStorage;
    if (!storage) return false;
    const fence = readFence();
    if (!fence) return true;
    if (expectedToken && fence.token !== expectedToken) return true;
    if (address && fence.address !== address.toLowerCase()) return true;
    storage.removeItem(WEB_SIGN_OUT_PENDING_KEY);
    return storage.getItem(WEB_SIGN_OUT_PENDING_KEY) === null;
  } catch {
    return false;
  }
}
