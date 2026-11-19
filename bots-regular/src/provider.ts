// The one seam between the regular runtime and the machines its bots run on. The service only ever names a sandbox by
// the id built here from a bot's hashed id, so a sandbox, and the snapshot it wakes from, belongs to exactly one bot.

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
 * and the local check use a fake. Every method takes a sandbox id and touches that sandbox only.
 */
export interface SandboxProvider {
  /**
   * Returns the running sandbox, waking it from its own newest snapshot or creating it empty. Its boot process (the
   * bridge) starts with it, holding no token until it is armed.
   */
  acquire(id: string, signal: AbortSignal): Promise<void>;
  /**
   * Runs one command in the sandbox. `env` reaches the command only: it is never written to the sandbox's files, its
   * pod spec or its labels.
   */
  exec(id: string, command: string, env: Record<string, string>, timeoutSeconds: number): Promise<ExecResult>;
  /** `http://<address>:<port>` of the sandbox's running machine. Addresses are reused, so this is never cached. */
  endpoint(id: string, port: number): Promise<string>;
  /** Restarts the sandbox's idle period, so the host's sweeper does not put it to sleep while a turn runs. */
  touch(id: string): Promise<void>;
  /** Saves its files to its snapshot and stops it. */
  sleep(id: string): Promise<void>;
  /** Deletes the sandbox, awake or asleep, and every snapshot of it. */
  destroy(id: string): Promise<void>;
}
