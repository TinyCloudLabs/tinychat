import type { DelegatingServerInfo, ServerInfo } from "../src/index";

const nonDelegatingInfo: ServerInfo = {
  did: "did:key:non-delegating",
  status: "ok",
};

const delegatingInfo: DelegatingServerInfo = {
  did: "did:key:backend",
  status: "ok",
  name: "Backend",
  expiry: "7d",
  policyHash: "sha256:backend-policy",
  permissions: [
    {
      service: "tinycloud.kv",
      path: "items/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
    },
  ],
};

delegatingInfo.policyHash satisfies string;
delegatingInfo.permissions[0].service satisfies string;
nonDelegatingInfo.status satisfies string;

// @ts-expect-error policyHash is required for delegation backends.
const _missingPolicyHash: DelegatingServerInfo = {
  did: "did:key:backend",
  status: "ok",
  permissions: [
    {
      service: "tinycloud.kv",
      path: "items/",
      actions: ["tinycloud.kv/get"],
    },
  ],
};

// @ts-expect-error at least one permission is required for delegation backends.
const _missingPermissions: DelegatingServerInfo = {
  did: "did:key:backend",
  status: "ok",
  policyHash: "sha256:backend-policy",
};
