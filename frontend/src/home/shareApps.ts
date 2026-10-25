// The three template apps Share lists in its catalog (share repo apps/catalog.json,
// docs/apps-catalog.md). Home only links to Share's existing runner: nothing here
// reads user data, calls a network API or grants Home any permission.

export const SHARE_ORIGIN = "https://share.tinycloud.xyz";

export interface ShareApp {
  /** The catalog's `app_id`, the runner's address fragment. */
  appId: string;
  name: string;
  description: string;
}

export const SHARE_APPS: readonly ShareApp[] = [
  { appId: "com.example.notes", name: "Notes", description: "Notes with KV documents and SQLite search metadata." },
  {
    appId: "xyz.tinycloud.sample.healthlog",
    name: "Health Log",
    description: "A small health log: meals with macros, body weight, a today card and a last-7-days chart.",
  },
  {
    appId: "xyz.tinycloud.sample.recipes",
    name: "Recipes",
    description: "A small recipe book: shelves, recipes, and recipes started from a meal in the Health Log.",
  },
];

/** Share's runner address for an app: `/apps/run#<app_id>`. */
export function shareRunUrl(appId: string): string {
  return `${SHARE_ORIGIN}/apps/run#${encodeURIComponent(appId)}`;
}
