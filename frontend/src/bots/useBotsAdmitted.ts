// Whether the backend lets this account use bots (TC-3325), decided as Home's ask box decides it (HomeAskBox.tsx):
// the status says bots are on for the account, and a read of Main's messages comes back. A failed check is tried
// again each minute. Null until the first answer; false for any account it says no to, and while signed out.
import { useEffect, useState } from "react";

import type { BotsApi } from "./botsApi";

const RETRY_MS = 60_000;

/** Null `api`: signed out or not checked here; always false. */
export function useBotsAdmitted(api: BotsApi | null): boolean | null {
  const [admitted, setAdmitted] = useState<{ api: BotsApi; admitted: boolean } | null>(null);
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        if (!(await api.getBotsStatus(controller.signal)).enabled) {
          if (!controller.signal.aborted) setAdmitted({ api, admitted: false });
          return;
        }
        await api.listMainMessages(controller.signal);
        if (!controller.signal.aborted) setAdmitted({ api, admitted: true });
      } catch {
        if (controller.signal.aborted) return;
        setAdmitted({ api, admitted: false });
        timer = setTimeout(() => void check(), RETRY_MS);
      }
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api]);
  if (!api) return false;
  return admitted?.api === api ? admitted.admitted : null;
}
