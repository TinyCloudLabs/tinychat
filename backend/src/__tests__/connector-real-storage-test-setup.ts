import { afterEach, beforeEach } from "bun:test";

export function useRealConnectorStorageInTests(): void {
  const setting = "CONNECTOR_KEY_STORE_TEST_PLAINTEXT";
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[setting];
    delete process.env[setting];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[setting];
    else process.env[setting] = previous;
  });
}
