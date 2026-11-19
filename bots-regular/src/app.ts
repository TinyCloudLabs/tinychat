// The internal API of the regular runtime: createApp from bots/, for calls signed for the `regular` environment, with
// the legacy owner header turned off.

import { type AppOptions, createApp } from "../../bots/src/server";

export function regularApp(options: Pick<AppOptions, "secret" | "accounts" | "bots" | "manifest">) {
  return createApp({ ...options, environment: "regular", acceptLegacyOwnerHeader: false });
}
