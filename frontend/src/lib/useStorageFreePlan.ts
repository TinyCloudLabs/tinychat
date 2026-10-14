import { useSyncExternalStore } from "react";
import { isFreeStoragePlan, subscribeStoragePlan } from "./storageStatus";

/** True only when the signed-in plan is positively Free. Unknown plans read as paid, so no Upgrade is offered. */
export function useStorageFreePlan(): boolean {
  return useSyncExternalStore(subscribeStoragePlan, isFreeStoragePlan, () => false);
}
