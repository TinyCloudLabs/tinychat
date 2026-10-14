import { useSyncExternalStore } from "react";
import { isFreeStoragePlan, subscribeStoragePlan } from "./storageStatus";

/** True only when the signed-in plan is positively Free. Unknown plans read as paid: the detail copy and Upgrade both need this. */
export function useStorageFreePlan(): boolean {
  return useSyncExternalStore(subscribeStoragePlan, isFreeStoragePlan, () => false);
}
