// Keeps the server import going while TinyCloud One is open: every 30 seconds, on a visible page, it replaces the
// permissions our server holds once they are close to ending, and only when this sign-in can extend them. It never
// asks for anything and renders nothing.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect } from "react";

import {
  readFirefliesImportWanted,
  renewFirefliesImportIfDue,
  signFirefliesImportGrants,
  type FirefliesImportDeps,
} from "@/lib/connectors/firefliesImport";
import { createFirefliesImportGrantsClient } from "@/lib/connectors/firefliesImportGrantsApi";
import {
  fetchFirefliesServerImportCapability,
  firefliesServerImportEnabled,
} from "@/lib/connectors/firefliesServerImportFeature";

const TICK_MS = 30_000;

export function FirefliesImportRenewer({
  tcw,
  sessionStore,
  backendUrl,
}: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
}) {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    const deps: FirefliesImportDeps = {
      api: createFirefliesImportGrantsClient(backendUrl, { sessionStore }),
      sign: (delegateDid) => signFirefliesImportGrants(tcw, sessionStore, delegateDid),
      revoke: async (cid) => (await tcw.revokeDelegation(cid)).ok,
    };
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const siwe = tcw.session()?.siwe;
      const address = sessionStore.getAddress()?.toLowerCase();
      if (!siwe || !address || !sessionStore.getToken()) return;
      void renewFirefliesImportIfDue(deps, { siwe, wanted: readFirefliesImportWanted(address) });
    };
    void fetchFirefliesServerImportCapability(backendUrl, fetch, controller.signal).then((caps) => {
      if (controller.signal.aborted || !firefliesServerImportEnabled(undefined, caps)) return;
      tick();
      timer = setInterval(tick, TICK_MS);
    });
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [tcw, sessionStore, backendUrl]);
  return null;
}
