// The only file that imports fake-indexeddb (devDependency, pending approval). If it is
// rejected, replace newIdbEnv with a hand-written IndexedDB fake here and nothing else changes.

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { IdbEnv } from "../idb";

export const newIdbEnv = (): IdbEnv => ({
  factory: new IDBFactory() as unknown as IDBFactory,
  keyRange: IDBKeyRange as unknown as typeof globalThis.IDBKeyRange,
});
