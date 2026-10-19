import { useSyncExternalStore } from "react";
import { isStorageReadOnly, subscribeStorageReadOnly } from "@/lib/storageStatus";

/** App-wide storage-full state from `storageStatus.ts`: true while TinyCloud storage is full. */
export function useStorageReadOnly(): boolean {
  return useSyncExternalStore(subscribeStorageReadOnly, isStorageReadOnly, () => false);
}
