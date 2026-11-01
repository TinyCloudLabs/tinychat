import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { deleteReplicaDatabase, REPLICA_DATABASE_NAME } from "./replicationLocalStore";

let factory: IDBFactory;
const originals = {
  indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  navigator: Object.getOwnPropertyDescriptor(globalThis, "navigator"),
};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(REPLICA_DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("rows");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

beforeEach(() => {
  factory = new IDBFactory();
  define("indexedDB", factory);
  define("navigator", { locks: { request: async (_name: string, callback: () => unknown) => callback() } });
});
afterEach(() => {
  for (const [name, descriptor] of [["indexedDB", originals.indexedDB], ["navigator", originals.navigator]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});

describe("a delete queued behind a blocked one", () => {
  // Real timers on purpose: this exercises the platform's queueing (a second deleteDatabase fires neither
  // success nor blocked until the first is processed), which a fake clock cannot reproduce.
  test("gives up with a code instead of holding the gate lock forever, and the next attempt works once the holder is gone", async () => {
    const holder = await open();
    expect(await deleteReplicaDatabase(10)).toEqual({ ok: false, code: "DELETE_BLOCKED" });
    expect(await deleteReplicaDatabase(10)).toEqual({ ok: false, code: "DELETE_TIMEOUT" });
    holder.close();
    expect(await deleteReplicaDatabase(10)).toEqual({ ok: true });
    expect((await factory.databases()).some((db) => db.name === REPLICA_DATABASE_NAME)).toBe(false);
  });
});
