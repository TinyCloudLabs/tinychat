// The interface between the regular runtime and its sandbox host. Sandbox ids are built here from bot ids.

import { BOT_ID } from "../../bots/src/owner";

/** A sandbox id: "bot-" and the first 52 hex characters of the bot id (the library allows a 56-character DNS label). */
export function sandboxIdFor(botId: string): string {
  if (!BOT_ID.test(botId)) throw new Error("invalid bot id");
  return `bot-${botId.slice(0, 52)}`;
}

export const SANDBOX_ID = /^bot-[0-9a-f]{52}$/;

export interface ExecResult {
  exitCode: number;
  output: string;
}

/**
 * What the service needs from a sandbox host. The real one is gke-sandboxes on Google Cloud (gke-provider.ts); tests
 * and local runs use LocalProvider. Every method takes a sandbox id.
 */
export interface SandboxProvider {
  /**
   * Returns once the sandbox is running, woken from its newest snapshot or created empty. Its boot process (the
   * bridge) starts with it.
   */
  acquire(id: string, signal: AbortSignal): Promise<void>;
  /**
   * Runs one command in the sandbox, with `env` in the command's environment.
   */
  exec(id: string, command: string, env: Record<string, string>, timeoutSeconds: number): Promise<ExecResult>;
  /** `http://<address>:<port>` of the sandbox's running pod. Looked up on every call. */
  endpoint(id: string, port: number): Promise<string>;
  /** Restarts the sandbox's idle period. */
  touch(id: string): Promise<void>;
  /** Saves its files to its snapshot and stops it. */
  sleep(id: string): Promise<void>;
  /** Deletes the sandbox, awake or asleep, and every snapshot of it. */
  destroy(id: string): Promise<void>;
}
