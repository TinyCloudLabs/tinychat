import { expect, test } from "bun:test";
import { secretKeyPath } from "@tinycloud/sdk-services";

import { connectorKeyPermissions } from "./connectorKeyAccess";
import { CONNECTORS } from "./registry";

// TC-3804 (Naomi 13:05Z): only Secret Manager's /app sign-in and the CLI's --paste --all-secrets may ask for decrypt on
// the `secrets/` prefix. Every key TinyChat asks for is one connector's exact `secrets/<name>` key.
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NETWORK = `urn:tinycloud:encryption:did:pkh:eip155:1:${ADDRESS}:default`;

test("every connector asks for its exact secret key, never the secrets/ prefix", () => {
  expect(connectorKeyPermissions(ADDRESS, 1, CONNECTORS).map((entry) => entry.path)).toEqual(
    CONNECTORS.map((d) => `${NETWORK}/${secretKeyPath(d.secretName, d.secretScope)}`),
  );
  for (const { path } of connectorKeyPermissions(ADDRESS, 1, CONNECTORS)) {
    expect(path).toMatch(new RegExp(`^${NETWORK.replace(/[.:]/g, "\\$&")}/secrets/(scoped/[^/]+/)?[a-z0-9_]+$`));
  }
});
