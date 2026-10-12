/**
 * Generate a random Ethereum-compatible private key.
 *
 * Usage:
 *   bun run packages/server/scripts/generate-key.ts [env-file]
 *
 * Creates a new env file. Refuses to overwrite an existing one.
 */

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const envPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(import.meta.dir, "../../../.env");

if (existsSync(envPath)) throw new Error(`Refusing to overwrite existing env file: ${envPath}`);
const key = `0x${randomBytes(32).toString("hex")}`;
mkdirSync(dirname(envPath), { recursive: true });
writeFileSync(envPath, `BACKEND_PRIVATE_KEY=${key}\n`, { mode: 0o600, flag: "wx" });
console.log(`Created .env file at ${envPath}`);
