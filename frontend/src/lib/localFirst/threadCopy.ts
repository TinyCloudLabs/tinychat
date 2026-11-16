import type { ThreadCopyStore } from "../historyPrefetch";
import type { ThreadDoc } from "../threadStore";
import { accountCacheKey, deleteLocal, readLocalKind, writeLocal } from "./localCache";

const THREAD_KIND = "thread";

/** The device's copy of an account's chat histories, kept by the history copy. */
export function threadCopyFor(account: string): ThreadCopyStore {
  return {
    save: (doc) => void writeLocal(accountCacheKey(account, THREAD_KIND, doc.id), doc),
    remove: (id) => void deleteLocal(accountCacheKey(account, THREAD_KIND, id)),
  };
}

/** Every chat history this device has copied for the account. */
export async function readThreadCopy(account: string): Promise<ThreadDoc[]> {
  return [...(await readLocalKind<ThreadDoc>(account, THREAD_KIND)).values()].map((entry) => entry.value);
}
