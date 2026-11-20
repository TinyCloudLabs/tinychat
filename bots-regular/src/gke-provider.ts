// The gke-sandboxes provider: @getenergy/gke-sandboxes 0.3.0 on Google Cloud. Used by a deployed service and by
// scripts/real-cluster-check.ts; the tests use LocalProvider.

import { readFile } from "node:fs/promises";
import { GkeSandboxes, KubernetesApi, type SandboxResources } from "@getenergy/gke-sandboxes";
import type { ExecResult, SandboxProvider } from "./provider";

/** Where the bridge lives in the sandbox image (Dockerfile target `sandbox`). */
export const BRIDGE_SCRIPT = "/opt/bridge/bridge.ts";
export const ARM_COMMAND = "bun /opt/bridge/arm.ts";

export interface GkeProviderOptions {
  /** The Kubernetes API: https://kubernetes.default.svc inside the cluster, the cluster's DNS endpoint outside. */
  apiUrl: string;
  /** An access token for an identity bound to the library's `sandbox-controller` Role. */
  token: () => Promise<string>;
  namespace: string;
  serviceAccount: string;
  /** The sandbox image, pinned by digest. */
  image: string;
  /** What each sandbox reserves on its machine and may use at most (config.ts). */
  resources: SandboxResources;
}

/** Inside the cluster: the service account token the kubelet keeps current, read for every call as it rotates. */
export const inClusterToken = async () =>
  (await readFile("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8")).trim();

export class GkeProvider implements SandboxProvider {
  readonly #sandboxes: GkeSandboxes;
  /** The `touch` that `acquire` returned, per sandbox; the library offers no other. */
  readonly #touches = new Map<string, () => Promise<void>>();

  constructor(options: GkeProviderOptions) {
    this.#sandboxes = new GkeSandboxes(new KubernetesApi(options.apiUrl, options.token), {
      namespace: options.namespace,
      serviceAccount: options.serviceAccount,
      image: options.image,
      resources: options.resources,
      // Starts the bridge with every pod.
      boot: () => ({ shell: `exec bun ${BRIDGE_SCRIPT}`, args: [] }),
      memoryWatchdog: { protect: [BRIDGE_SCRIPT] },
      // The service's own sleep call succeeds one second after its last touch. The library's sweeper sleeps sandboxes
      // left awake after its own idle time.
      idleTimeoutMs: 1000,
      onOperation: ({ operation, outcome, labels, durationMs, error }) =>
        console.log(JSON.stringify({
          bots: "sandbox",
          operation,
          outcome,
          sandbox: labels["energy-sandbox"],
          duration_ms: durationMs,
          error: error ? String(error).slice(0, 300) : undefined,
        })),
    });
  }

  async acquire(id: string, signal: AbortSignal): Promise<void> {
    const { touch } = await this.#sandboxes.acquire(id, signal);
    this.#touches.set(id, touch);
  }

  async exec(id: string, command: string, env: Record<string, string>, timeoutSeconds: number): Promise<ExecResult> {
    const result = await this.#sandboxes.environment(id, "started").process.executeCommand(command, "/", env, timeoutSeconds);
    return { exitCode: result.exitCode, output: result.result };
  }

  async endpoint(id: string, port: number): Promise<string> {
    return (await this.#sandboxes.endpoint({ id }, port)).url;
  }

  async touch(id: string): Promise<void> {
    await this.#touches.get(id)?.();
  }

  async sleep(id: string): Promise<void> {
    this.#touches.delete(id);
    await this.#sandboxes.sleep(id);
  }

  async destroy(id: string): Promise<void> {
    this.#touches.delete(id);
    await this.#sandboxes.delete(id);
  }
}
