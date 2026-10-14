import { useSyncExternalStore } from "react";
import { isFreeStoragePlan, subscribeStoragePlan } from "./storageStatus";

/** True only when the paywall is on and the signed-in plan is positively Free. Unknown plans read as paid, so no Upgrade is offered. */
export function useStorageFreePlan(paywallEnabled: boolean): boolean {
  const freePlan = useSyncExternalStore(subscribeStoragePlan, isFreeStoragePlan, () => false);
  return paywallEnabled && freePlan;
}
