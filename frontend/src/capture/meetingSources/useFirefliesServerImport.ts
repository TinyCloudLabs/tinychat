// State for the "Import meetings while TinyCloud One is closed" row. The rules live in lib/connectors/firefliesImport.ts;
// this hook reads what the server holds, runs turn on and turn off, and reports one phase for the row to render.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  firefliesImportPhase,
  signFirefliesImportGrants,
  turnOffFirefliesImport,
  turnOnFirefliesImport,
  writeFirefliesImportWanted,
  type FirefliesImportDeps,
  type FirefliesImportPhase,
} from "@/lib/connectors/firefliesImport";
import {
  createFirefliesImportGrantsClient,
  createFirefliesImportGrantsTeardown,
} from "@/lib/connectors/firefliesImportGrantsApi";
import {
  fetchFirefliesServerImportCapability,
  firefliesServerImportEnabled,
} from "@/lib/connectors/firefliesServerImportFeature";

export type FirefliesServerImportPhase =
  | "hidden"
  | "loading"
  | FirefliesImportPhase
  | "working"
  | "unavailable"
  | "needs-sign-in"
  | "off-unconfirmed";

export interface FirefliesServerImportView {
  phase: FirefliesServerImportPhase;
  /** When the permissions the server holds end; null when it holds none. */
  expiresAt: string | null;
}

export interface UseFirefliesServerImport {
  view: FirefliesServerImportView;
  turnOn: () => void;
  turnOff: () => void;
  retry: () => void;
}

/**
 * `active` is false while the row is not offered (Fireflies not connected, or instant updates not on): nothing is
 * read from the server and nothing is signed.
 */
export function useFirefliesServerImport(options: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  active: boolean;
}): UseFirefliesServerImport {
  const { tcw, backendUrl, sessionStore, active } = options;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [view, setView] = useState<FirefliesServerImportView>({ phase: "loading", expiresAt: null });
  const latestExpiry = useRef<string | null>(null);
  const settled = (next: FirefliesServerImportView) => {
    latestExpiry.current = next.expiresAt;
    setView(next);
  };

  const api = useMemo(() => createFirefliesImportGrantsClient(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const grants = useMemo(
    () => createFirefliesImportGrantsTeardown(tcw, backendUrl, sessionStore),
    [tcw, backendUrl, sessionStore],
  );
  const deps = useMemo<FirefliesImportDeps>(
    () => ({
      api,
      sign: (delegateDid) => signFirefliesImportGrants(tcw, sessionStore, delegateDid),
      revoke: async (cid) => (await tcw.revokeDelegation(cid)).ok,
    }),
    [api, tcw, sessionStore],
  );

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetchFirefliesServerImportCapability(backendUrl, fetch, controller.signal).then((caps) => {
      if (!controller.signal.aborted) setEnabled(firefliesServerImportEnabled(undefined, caps));
    });
    return () => controller.abort();
  }, [active, backendUrl]);

  const read = useCallback(async () => {
    const status = await api.status();
    if (status.status === "ok") {
      settled({ phase: firefliesImportPhase(status.value), expiresAt: status.value.expiresAt });
    } else if (status.status === "unauthenticated") {
      settled({ phase: "needs-sign-in", expiresAt: null });
    } else {
      settled({ phase: "unavailable", expiresAt: latestExpiry.current });
    }
  }, [api]);

  useEffect(() => {
    if (active && enabled === true) void read();
  }, [active, enabled, read]);

  const address = () => sessionStore.getAddress()?.toLowerCase() ?? null;

  const turnOn = useCallback(() => {
    setView((was) => ({ ...was, phase: "working" }));
    void turnOnFirefliesImport(deps).then(async (outcome) => {
      if (outcome.kind === "on") {
        const who = address();
        if (who) writeFirefliesImportWanted(who, true);
        await read();
      } else if (outcome.kind === "needs-sign-in") {
        settled({ phase: "needs-sign-in", expiresAt: latestExpiry.current });
      } else {
        settled({ phase: "unavailable", expiresAt: latestExpiry.current });
      }
    });
  }, [deps, read]);

  const turnOff = useCallback(() => {
    const endsAt = latestExpiry.current;
    setView((was) => ({ ...was, phase: "working" }));
    void turnOffFirefliesImport(api, grants).then((outcome) => {
      if (outcome.kind === "unavailable") {
        settled({ phase: "unavailable", expiresAt: endsAt });
        return;
      }
      const who = address();
      if (who) writeFirefliesImportWanted(who, false);
      settled(outcome.kind === "off" ? { phase: "off", expiresAt: null } : { phase: "off-unconfirmed", expiresAt: endsAt });
    });
  }, [api, grants]);

  if (!active || enabled === false) return { view: { phase: "hidden", expiresAt: null }, turnOn, turnOff, retry: read };
  if (enabled === null) return { view: { phase: "loading", expiresAt: null }, turnOn, turnOff, retry: read };
  return { view, turnOn, turnOff, retry: read };
}
