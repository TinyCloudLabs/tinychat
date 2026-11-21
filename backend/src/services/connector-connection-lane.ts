import { normalizeWebhookAddress } from "./webhook-tokens.js";

const changes = new Map<string, Promise<void>>();

/** Serialize connection changes across credentials, callback tokens and the purge ledger. */
export async function withConnectorConnectionChange<T>(address: string, change: () => Promise<T>): Promise<T> {
  const owner = normalizeWebhookAddress(address);
  const run = (changes.get(owner) ?? Promise.resolve()).then(change);
  const tail = run.then(() => undefined, () => undefined);
  changes.set(owner, tail);
  try {
    return await run;
  } finally {
    if (changes.get(owner) === tail) changes.delete(owner);
  }
}
