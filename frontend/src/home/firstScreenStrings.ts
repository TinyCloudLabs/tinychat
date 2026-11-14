// User-facing copy for the first-screen setting (TC-2040), worded by Monica.
import { APP_NAME } from "@/lib/homeSite";
import { SCREEN_NAME } from "@/lib/homeStrings";

export const FIRST_SCREEN_STRINGS = {
  heading: "First screen",
  feed: SCREEN_NAME,
  apps: "Apps",
  hint: `Choose what ${APP_NAME} opens on.`,
  loading: "Loading your setting…",
  error: "Couldn't save your choice. Try again.",
  readError: `Couldn't load your setting, so ${APP_NAME} opens on ${SCREEN_NAME} for now.`,
} as const;
