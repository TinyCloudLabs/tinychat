import { EXO_SYNC_GRANT_KIND, TRANSCRIPT_WRITER_GRANT_KIND } from "@tinyboilerplate/server";
import { BOT_HISTORY_GRANT_KEY_PREFIX } from "./bot-history.js";
import { BOTS_REGISTRY_KEY_PREFIX } from "./bots-registry.js";
import { EXO_HELD_KEY_PREFIX, EXO_LEDGER_KEY_PREFIX, EXO_SOURCE_LOCK_KEY_PREFIX } from "./exo/durable-ledger.js";
import { EXO_MIRROR_JOBS_PREFIX } from "./exo/stores.js";
import { CORRUPT_PURGED_KEY_PREFIX, DISABLED_KEY_PREFIX, PURGE_LEDGER_KEY_PREFIX } from "./routes/connector-webhooks.js";
import { HOSTED_IDENTITY_KEY } from "./services/assemblyai-hosted.js";
import { CALENDAR_AUTOJOIN_KEY_PREFIX } from "./services/calendar-autojoin-store.js";
import {
  CONFIG_KEY_PREFIX as DRAIN_CONFIG_KEY_PREFIX,
  CORRUPT_PURGE_LEDGER_KEY_PREFIX as DRAIN_CORRUPT_PURGE_LEDGER_KEY_PREFIX,
  PURGE_LEDGER_KEY_PREFIX as DRAIN_PURGE_LEDGER_KEY_PREFIX,
} from "./services/connector-drain.js";
import { CORRUPT_KEY_PREFIX, DEAD_KEY_PREFIX, PENDING_KEY_PREFIX } from "./services/connector-queue.js";
import { CREDENTIAL_KEY_PREFIX } from "./services/credential-store.js";
import { FIREFLIES_IMPORT_GRANT_KEY_PREFIX } from "./services/fireflies-grant-store.js";
import { TRANSCRIBER_INDEX_KEY_PREFIX } from "./services/transcriber-index.js";
import { TRANSCRIPT_DELIVERY_KEY_PREFIX } from "./services/transcript-delivery.js";
import { WEBHOOK_CONFIG_KEY_PREFIX, WEBHOOK_TOKEN_KEY_PREFIX } from "./services/webhook-tokens.js";

/**
 * Every key root the backend reads or writes in its own space, taken from the constants its stores
 * build keys from. Startup refuses to sign in when the backend manifest leaves one of these out, so
 * a store that adds a root adds its constant here.
 */
export const BACKEND_KV_ROOTS: readonly string[] = [
  TRANSCRIPT_WRITER_GRANT_KIND.keyPrefix,
  EXO_SYNC_GRANT_KIND.keyPrefix,
  FIREFLIES_IMPORT_GRANT_KEY_PREFIX,
  WEBHOOK_TOKEN_KEY_PREFIX,
  WEBHOOK_CONFIG_KEY_PREFIX,
  DRAIN_CONFIG_KEY_PREFIX,
  PENDING_KEY_PREFIX,
  DEAD_KEY_PREFIX,
  CORRUPT_KEY_PREFIX,
  DISABLED_KEY_PREFIX,
  PURGE_LEDGER_KEY_PREFIX,
  CORRUPT_PURGED_KEY_PREFIX,
  DRAIN_PURGE_LEDGER_KEY_PREFIX,
  DRAIN_CORRUPT_PURGE_LEDGER_KEY_PREFIX,
  CREDENTIAL_KEY_PREFIX,
  TRANSCRIBER_INDEX_KEY_PREFIX,
  TRANSCRIPT_DELIVERY_KEY_PREFIX,
  HOSTED_IDENTITY_KEY,
  CALENDAR_AUTOJOIN_KEY_PREFIX,
  BOT_HISTORY_GRANT_KEY_PREFIX,
  BOTS_REGISTRY_KEY_PREFIX,
  EXO_MIRROR_JOBS_PREFIX,
  EXO_LEDGER_KEY_PREFIX,
  EXO_SOURCE_LOCK_KEY_PREFIX,
  EXO_HELD_KEY_PREFIX,
];
