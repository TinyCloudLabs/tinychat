// The words for the server import row. Written by the copy owner; do not reword here.

export const FIREFLIES_IMPORT_HEADING = "Import meetings while TinyCloud One is closed";

export const FIREFLIES_IMPORT_OFF_BODY = [
  "When a Fireflies meeting finishes, our server can save it to your TinyCloud even while TinyCloud One is closed. To do that, you give our server two permissions for up to 7 days: one to open your Fireflies key for each import, and one to save meetings into your Fireflies folder. Our server doesn't keep your Fireflies key or a copy of any meeting.",
  "The permissions renew each time you open TinyCloud One. If you don't open it for several days, imports pause: at most 7 days after your last visit, sooner if your sign-in is close to ending. Meetings that finished in the meantime are saved the next time you open it. You can turn this off at any time. It's your choice and applies only to your account.",
] as const;

export const FIREFLIES_IMPORT_TURN_ON = "Turn on";
export const FIREFLIES_IMPORT_NOT_NOW = "Not now";
export const FIREFLIES_IMPORT_TURN_OFF = "Turn off";
export const FIREFLIES_IMPORT_CANCEL = "Cancel";
export const FIREFLIES_IMPORT_KEEP_ON = "Keep it on";
export const FIREFLIES_IMPORT_TRY_AGAIN = "Try again";

export const firefliesImportOnLine = (date: string) =>
  `On until ${date}. Meetings that finish while TinyCloud One is closed are saved to your TinyCloud. Opening TinyCloud One extends this.`;

export const FIREFLIES_IMPORT_TURN_OFF_CONFIRM =
  "Turn off importing on our server? Our server stops importing and its permissions are withdrawn. Meetings already saved stay in your TinyCloud; use Delete meetings to remove them.";

export const firefliesImportEndingSoonLine = (date: string) => `Ends ${date}. Open TinyCloud One to keep it on.`;
export const firefliesImportSignInLine = (date: string) => `Ends ${date}. Sign in to TinyCloud One to keep it on.`;

export const FIREFLIES_IMPORT_PAUSED_LINE =
  "Paused. Meetings that finish while paused are saved the next time you open TinyCloud One.";

export const firefliesImportUnconfirmedLine = (date: string) =>
  `Importing is off on our server, but OpenKey couldn't confirm the permissions were withdrawn. They end on ${date} at the latest.`;

export const FIREFLIES_IMPORT_UNAVAILABLE_LINE = "TinyCloud One couldn't reach our server. Try again.";

/** Not in the copy owner's list; shown only when no permission can be signed and no end date is known. */
export const FIREFLIES_IMPORT_SIGN_IN_TO_TURN_ON_LINE = "Sign in to TinyCloud One to turn this on.";

/** The date shown in the lines above, in the reader's own locale. */
export function firefliesImportDate(iso: string | null): string {
  const parsed = iso ? new Date(iso) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return "the end of the week";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
