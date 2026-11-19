// The internal API of the regular runtime: the private runtime's own, taking calls signed for the regular environment
// with this service's own secret, and nothing else: never the legacy header, never a call signed for the private one.

import { type AppOptions, createApp } from "../../bots/src/server";

export function regularApp(options: Pick<AppOptions, "secret" | "accounts" | "bots" | "manifest">) {
  return createApp({ ...options, environment: "regular", acceptLegacyOwnerHeader: false });
}
