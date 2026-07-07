// Sync the CVM's dstack allowed_envs whitelist with the deploy env file.
//
// `phala deploy` submits the encrypted env but never updates the CVM's
// registered allowed_envs (the dstack app-compose whitelist that gates which
// encrypted env vars are injected into docker-compose). The whitelist is only
// set at CVM creation, so vars added later (AGENT_DID, ELIZA_SERVICE_URL,
// ELIZA_SERVICE_SECRET, the Stripe/paywall set, ...) are silently dropped at
// injection time — that unmounted /api/agent in prod on 2026-07-07.
//
// The canonical way to change allowed_envs is PATCH /cvms/{id}/envs with
// env_keys (two-phase: a first call returns precondition_required with the
// new compose_hash, the retry with that hash commits). This script performs
// that dance with the exact same env file the deploy step just used, so
// values are identical — only the whitelist changes.
//
// Env: PHALA_CLOUD_API_KEY, PHALA_CVM_ID, ENV_FILE (path to KEY=VALUE file).

import { readFileSync } from "node:fs";
import {
  createClient,
  getCvmInfo,
  getCvmComposeFile,
  updateCvmEnvs,
  encryptEnvVars,
} from "@phala/cloud";

const apiKey = process.env.PHALA_CLOUD_API_KEY;
const cvmId = process.env.PHALA_CVM_ID;
const envFile = process.env.ENV_FILE;
if (!apiKey || !cvmId || !envFile) {
  console.error("PHALA_CLOUD_API_KEY, PHALA_CVM_ID and ENV_FILE are required");
  process.exit(1);
}

const envs = [];
for (const line of readFileSync(envFile, "utf8").split("\n")) {
  if (!line.trim() || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i <= 0) continue;
  envs.push({ key: line.slice(0, i), value: line.slice(i + 1) });
}
const envKeys = envs.map((e) => e.key);
if (envKeys.length === 0) {
  console.error(`No env vars parsed from ${envFile}`);
  process.exit(1);
}

const client = createClient({ apiKey });

const compose = await getCvmComposeFile(client, { uuid: cvmId }, { schema: false });
const allowed = new Set(compose?.allowed_envs ?? []);
const missing = envKeys.filter((k) => !allowed.has(k));
if (missing.length === 0) {
  console.log(`allowed_envs already contains all ${envKeys.length} deploy env keys — nothing to do.`);
  process.exit(0);
}
console.log(`allowed_envs is missing ${missing.length} deploy env key(s): ${missing.join(", ")}`);

const info = await getCvmInfo(client, { uuid: cvmId }, { schema: false });
const pubkey = info?.encrypted_env_pubkey ?? info?.kms_info?.encrypted_env_pubkey;
if (!pubkey) {
  console.error("Could not resolve encrypted_env_pubkey from CVM info");
  process.exit(1);
}

const encryptedEnv = await encryptEnvVars(envs, pubkey);

let result = await updateCvmEnvs(
  client,
  { uuid: cvmId, encrypted_env: encryptedEnv, env_keys: envKeys },
  { schema: false },
);
console.log("phase 1 response:", JSON.stringify(result));

if (result?.status === "precondition_required") {
  result = await updateCvmEnvs(
    client,
    {
      uuid: cvmId,
      encrypted_env: encryptedEnv,
      env_keys: envKeys,
      compose_hash: result.compose_hash,
    },
    { schema: false },
  );
  console.log("phase 2 response:", JSON.stringify(result));
}

if (result?.status !== "in_progress") {
  console.error(`Unexpected env update result: ${JSON.stringify(result)}`);
  process.exit(1);
}
console.log(
  `Env update started (correlation ${result.correlation_id}, allowed_envs_changed=${result.allowed_envs_changed}). Waiting for CVM to settle...`,
);

// Wait for the update to start (status leaves "running"), then finish.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let started = false;
for (let i = 0; i < 120; i++) {
  await sleep(5000);
  const cur = await getCvmInfo(client, { uuid: cvmId }, { schema: false });
  const status = cur?.status ?? "unknown";
  if (!started) {
    if (status !== "running") started = true;
    else if (i >= 12) started = true; // update may be too fast to observe
    console.log(`[${(i + 1) * 5}s] status=${status} (waiting for update to ${started ? "finish" : "start"})`);
    continue;
  }
  console.log(`[${(i + 1) * 5}s] status=${status}`);
  if (status === "running") break;
  if (status === "failed" || status === "error") {
    console.error(`CVM entered status '${status}' after env update`);
    process.exit(1);
  }
}

const after = await getCvmComposeFile(client, { uuid: cvmId }, { schema: false });
const afterAllowed = new Set(after?.allowed_envs ?? []);
const stillMissing = envKeys.filter((k) => !afterAllowed.has(k));
if (stillMissing.length > 0) {
  console.error(`allowed_envs still missing after update: ${stillMissing.join(", ")}`);
  process.exit(1);
}
console.log(`allowed_envs now contains all ${envKeys.length} deploy env keys.`);
