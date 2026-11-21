import { useCallback, useEffect, useRef, useState } from "react";

import type { BotRoster, BotRosterApi, CreateBotInput } from "./botRosterApi";

type RosterState = {
  api: BotRosterApi | null;
  status: "loading" | "ready" | "failed";
  roster: BotRoster | null;
};

const empty = (api: BotRosterApi | null): RosterState => ({ api, status: "loading", roster: null });

/** The caller supplies an account-scoped client, or null while bots are disabled or signed out. */
export function useBots(api: BotRosterApi | null) {
  const [state, setState] = useState(() => empty(api));
  const request = useRef<{ api: BotRosterApi; controller: AbortController } | null>(null);
  const activeApi = useRef<BotRosterApi | null>(null);

  const reload = useCallback(async () => {
    if (!api || activeApi.current !== api) return;
    request.current?.controller.abort();
    const controller = new AbortController();
    request.current = { api, controller };
    try {
      const roster = await api.list(controller.signal);
      if (!controller.signal.aborted) setState({ api, status: "ready", roster });
    } catch {
      if (!controller.signal.aborted) setState(current => ({
        api, status: "failed", roster: current.api === api ? current.roster : null,
      }));
    } finally {
      if (request.current?.controller === controller) request.current = null;
    }
  }, [api]);

  useEffect(() => {
    activeApi.current = api;
    setState(empty(api));
    void reload();
    return () => {
      activeApi.current = null;
      if (request.current?.api === api) request.current?.controller.abort();
    };
  }, [api, reload]);

  const create = useCallback(async (input: CreateBotInput) => {
    if (!api || activeApi.current !== api) throw new Error("bots_unavailable");
    const bot = await api.create(input);
    await reload();
    if (activeApi.current !== api) throw new DOMException("The bot account changed", "AbortError");
    return bot;
  }, [api, reload]);

  const { status, roster } = state.api === api ? state : empty(api);
  return { status, roster, reload, create };
}
