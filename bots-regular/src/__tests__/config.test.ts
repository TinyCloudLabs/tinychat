import { describe, expect, test } from "bun:test";
import { regularConfig } from "../config";

const BASE = {
  BOTS_REGULAR_SERVICE_SECRET: "a".repeat(64),
  BOTS_REGULAR_PROVIDER: "gke",
  BOTS_REGULAR_SANDBOX_IMAGE: `example.com/sandbox@sha256:${"b".repeat(64)}`,
  BOTS_REGULAR_GATEWAY_ORIGIN: "http://bots-regular-gateway.bots-regular.svc:8081",
};

describe("sandbox sizing", () => {
  test("defaults fit one small machine, and every size comes from the environment", () => {
    const small = regularConfig(BASE);
    expect(small.maxRunning).toBe(4);
    expect(small.provider).toMatchObject({
      resources: {
        requests: { cpu: "250m", memory: "1Gi", "ephemeral-storage": "2Gi" },
        limits: { cpu: "1", memory: "2Gi", "ephemeral-storage": "8Gi" },
      },
    });

    const sized = regularConfig({
      ...BASE,
      BOTS_MAX_RUNNING: "12",
      BOTS_REGULAR_SANDBOX_CPU_REQUEST: "100m",
      BOTS_REGULAR_SANDBOX_MEMORY_REQUEST: "512Mi",
      BOTS_REGULAR_SANDBOX_DISK_REQUEST: "1Gi",
      BOTS_REGULAR_SANDBOX_CPU_LIMIT: "1.5",
      BOTS_REGULAR_SANDBOX_MEMORY_LIMIT: "1536Mi",
      BOTS_REGULAR_SANDBOX_DISK_LIMIT: "4Gi",
    });
    expect(sized.maxRunning).toBe(12);
    expect(sized.provider).toMatchObject({
      resources: {
        requests: { cpu: "100m", memory: "512Mi", "ephemeral-storage": "1Gi" },
        limits: { cpu: "1.5", memory: "1536Mi", "ephemeral-storage": "4Gi" },
      },
    });
  });

  test("a size that is not a Kubernetes quantity is refused at start", () => {
    for (const value of ["1GB", "-1Gi", "lots", "1 Gi"]) {
      expect(() => regularConfig({ ...BASE, BOTS_REGULAR_SANDBOX_MEMORY_LIMIT: value })).toThrow(
        "BOTS_REGULAR_SANDBOX_MEMORY_LIMIT must be a Kubernetes quantity",
      );
    }
  });
});
