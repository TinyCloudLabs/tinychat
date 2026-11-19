import { describe, expect, test } from "bun:test";
import { checkProbeNodeUrl, PROBE_REMOTE_OVERRIDE_VALUE } from "../../scripts/exo-probe-host-guard.js";

const refused = (raw: string, override?: string) => {
  const result = checkProbeNodeUrl(raw, override);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
};

describe("probe node URL host guard", () => {
  test.each([
    "http://127.0.0.1:18735",
    "http://[::1]:18735",
    "http://localhost:18735",
    "https://localhost/",
  ])("accepts loopback %s", (raw) => {
    expect(checkProbeNodeUrl(raw, undefined).ok).toBe(true);
  });

  test.each([
    "https://node.tinycloud.xyz.invalid",
    "https://node.tinycloud.xyz",
    "http://10.0.0.1:18735",
    "http://127.0.0.1.evil.com",
    "http://localhost.evil.com",
    "http://127.0.0.1@evil.com",
    "http://localhost@evil.com:18735",
    "ftp://127.0.0.1",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s without the override", (raw) => {
    refused(raw, undefined);
  });

  test("names the host and the override in the refusal", () => {
    const reason = refused("https://node.tinycloud.xyz.invalid", undefined);
    expect(reason).toContain("node.tinycloud.xyz.invalid");
    expect(reason).toContain(`EXO_PROBE_ALLOW_REMOTE_NODE=${PROBE_REMOTE_OVERRIDE_VALUE}`);
  });

  test("override admits a remote host over http or https", () => {
    expect(checkProbeNodeUrl("https://node.tinycloud.xyz", PROBE_REMOTE_OVERRIDE_VALUE).ok).toBe(true);
    expect(checkProbeNodeUrl("http://10.0.0.1:18735", PROBE_REMOTE_OVERRIDE_VALUE).ok).toBe(true);
  });

  test("override with any other value does not admit a remote host", () => {
    refused("https://node.tinycloud.xyz", "yes");
    refused("https://node.tinycloud.xyz", "true");
  });

  test("override never admits userinfo or a non-http scheme", () => {
    refused("http://127.0.0.1@evil.com", PROBE_REMOTE_OVERRIDE_VALUE);
    refused("ftp://node.tinycloud.xyz", PROBE_REMOTE_OVERRIDE_VALUE);
  });
});
