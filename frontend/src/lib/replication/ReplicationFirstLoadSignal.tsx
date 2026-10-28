import { useEffect } from "react";
import { getThreadListLoadState, subscribeThreadListSettled } from "../threadStore";
import { markAppFirstLoadSettled } from "./replicationFirstLoad";

/** Renders nothing. The thread store reports every completed list read, including warm revalidation and errors. */
export function ReplicationFirstLoadSignal(): null {
  useEffect(() => subscribeThreadListSettled(() => {
    const { status } = getThreadListLoadState();
    if (status === "ok" || status === "error") markAppFirstLoadSettled();
  }), []);
  return null;
}
