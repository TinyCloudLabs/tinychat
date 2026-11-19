// Whether the backend lets this account use bots (TC-3325), decided as Home's ask box decides it (HomeAskBox.tsx):
// the status says bots are on for the account, and a read of Main's messages comes back. A failed check is tried
// again each minute. False until then, and for every other account.
import { useEffect, useState } from "react";

import type { BotsApi } from "./botsApi";

const RETRY_MS = 60_000;

/** Null `api`: signed out or not checked here; always false. */
export function useBotsAdmitted(api: BotsApi | null): boolean {
  const [admitted, setAdmitted] = useState<{ api: BotsApi; admitted: boolean } | null>(null);
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        if (!(await api.getBotsStatus(controller.signal)).enabled) return;
        await api.listMainMessages(controller.signal);
        if (!controller.signal.aborted) setAdmitted({ api, admitted: true });
      } catch {
        if (!controller.signal.aborted) timer = setTimeout(() => void check(), RETRY_MS);
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api]);
  return !!api && admitted?.api === api && admitted.admitted;
}
