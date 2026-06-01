/**
 * Generate a random Ethereum-compatible private key.
 *
 * Usage:
 *   bun run packages/server/scripts/generate-key.ts [env-file]
 *
 * If no env file exists, creates one with the key.
 * If the env file already exists, prints the key to the console.
 */

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

const key = `0x${randomBytes(32).toString("hex")}`;
const envPath = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(import.meta.dir, "../../../.env");

if (!existsSync(envPath)) {
  mkdirSync(dirname(envPath), { recursive: true });
  writeFileSync(envPath, `BACKEND_PRIVATE_KEY=${key}\n`);
  console.log(`Created .env file with BACKEND_PRIVATE_KEY at ${envPath}`);
} else {
  console.log("Generated Ethereum private key:\n");
  console.log(`  BACKEND_PRIVATE_KEY=${key}\n`);
  console.log("WARNING: Keep this key secret. Do not commit it to version control.");
}
