// Loads the renewer in a chunk of its own once the signed-in shell mounts it: nothing boot or the first screen needs
// pulls the permission signing code into the entry chunk (src/shell/lazyTab.tsx, scripts/entry-size-check.ts).
// The renewer renders nothing, so a chunk that fails to load is simply no renewal this session.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useState, type ComponentType } from "react";

interface RenewerProps {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  backendUrl: string;
}

export function LazyFirefliesImportRenewer(props: RenewerProps) {
  const [Renewer, setRenewer] = useState<ComponentType<RenewerProps> | null>(null);
  useEffect(() => {
    let live = true;
    void import("./FirefliesImportRenewer").then(
      (loaded) => {
        if (live) setRenewer(() => loaded.FirefliesImportRenewer);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return Renewer ? <Renewer {...props} /> : null;
}
