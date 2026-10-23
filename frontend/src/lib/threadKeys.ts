import { APP_ID } from "@tinyboilerplate/core";

// Full resolved in-space path `${APP_ID}/threads`. Leaf module: share records and the thread
// store both derive their keys from it, so neither imports the other.
export const THREADS_SQL_DB_NAME = `${APP_ID}/threads`;
