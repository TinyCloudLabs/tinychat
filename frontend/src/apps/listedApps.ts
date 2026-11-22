// Apps listed only for some accounts (`listedIf`, registry.ts). One looks for the app's fixed key in the account's own
// `applications` space with one metadata read on its own session: the read grants the app nothing, and the key names
// no account.
import { useEffect, useMemo, useState } from "react";

import { ONE_APPS, type OneApp } from "./registry";

/** What the check needs from One's session: a KV metadata read (TinyCloudWeb's `kv.head`). */
export interface ListedAppsReader {
  kv: { head(key: string): Promise<{ ok: boolean }> };
}

const NONE: ReadonlySet<string> = new Set();

/** The apps to list, given which `listedIf` keys the account's space holds. */
export function listedApps(apps: readonly OneApp[], present: ReadonlySet<string>): readonly OneApp[] {
  return apps.filter((app) => app.kind !== "framed" || app.listedIf === undefined || present.has(app.listedIf));
}

/** The `listedIf` keys the space holds, one read each. A read that fails (missing, offline, refused) counts as absent. */
export async function presentKeys(reader: ListedAppsReader, apps: readonly OneApp[]): Promise<ReadonlySet<string>> {
  const keys = [...new Set(apps.flatMap((app) => (app.kind === "framed" && app.listedIf !== undefined ? [app.listedIf] : [])))];
  const found = await Promise.all(keys.map(async (key) => {
    try {
      return (await reader.kv.head(key)).ok;
    } catch {
      return false;
    }
  }));
  return new Set(keys.filter((_, index) => found[index]));
}

// One check per session: a new sign-in is a new session object.
const checked = new WeakMap<ListedAppsReader, ReadonlySet<string>>();

/** `apps` without the `listedIf` apps this account doesn't hold the key for; those stay hidden until the check finds it. */
export function useListedApps(reader: ListedAppsReader | null, apps: readonly OneApp[] = ONE_APPS): readonly OneApp[] {
  const [present, setPresent] = useState<ReadonlySet<string>>(() => (reader && checked.get(reader)) || NONE);
  useEffect(() => {
    if (!reader) {
      setPresent(NONE);
      return;
    }
    const known = checked.get(reader);
    if (known) {
      setPresent(known);
      return;
    }
    let live = true;
    void presentKeys(reader, apps).then((keys) => {
      checked.set(reader, keys);
      if (live) setPresent(keys);
    });
    return () => {
      live = false;
    };
  }, [reader, apps]);
  return useMemo(() => listedApps(apps, present), [apps, present]);
}
