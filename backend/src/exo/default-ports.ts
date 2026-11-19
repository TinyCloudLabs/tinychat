import { createMemoryExoLedger, type ExoMailboxPorts } from "./mailbox.js";

const NOT_WIRED = "exo job store is not wired; S4 supplies the concrete store";

/**
 * Fail-closed wiring used until S4 supplies concrete stores and an executor. No grant is active,
 * no request record is found, no connector is on, and no executor exists, so every wake is the
 * same 202 with no job created. A job store call is unreachable behind the grant check.
 */
export function createUnwiredExoPorts(frontendOrigin: string): ExoMailboxPorts {
  return {
    grants: { isActive: async () => false },
    requests: {
      get: async () => undefined,
      remove: async () => { throw new Error(NOT_WIRED); },
    },
    jobs: {
      get: async () => { throw new Error(NOT_WIRED); },
      putIfAbsent: async () => { throw new Error(NOT_WIRED); },
      put: async () => { throw new Error(NOT_WIRED); },
      list: async () => { throw new Error(NOT_WIRED); },
      remove: async () => { throw new Error(NOT_WIRED); },
    },
    connectors: {
      isOn: async () => false,
      hasFirefliesWebhook: async () => true,
    },
    ledger: createMemoryExoLedger(),
    now: () => Date.now(),
    frontendOrigin,
  };
}
