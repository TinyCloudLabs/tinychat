// The owner's local date and time zone, as the backend passes them on from the owner's browser. Display context for
// the model only: never used to decide access or limits.

import { isRecord } from "./guards";

export interface OwnerDate {
  /** The owner's local calendar day, YYYY-MM-DD. */
  localDate: string;
  /** The IANA time zone that day is in. */
  timeZone: string;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE = /^[A-Za-z0-9_+/-]{1,100}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** `value` as an OwnerDate when it holds a real YYYY-MM-DD day and a time zone this runtime knows; anything else is undefined. */
export function ownerDateFrom(value: unknown): OwnerDate | undefined {
  if (!isRecord(value)) return undefined;
  const { localDate, timeZone } = value;
  if (typeof localDate !== "string" || typeof timeZone !== "string" || !TIME_ZONE.test(timeZone)) return undefined;
  if (dayOf(localDate) === undefined) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    return undefined;
  }
  return { localDate, timeZone };
}

function dayOf(localDate: string): Date | undefined {
  const day = LOCAL_DATE.exec(localDate);
  if (!day) return undefined;
  const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const at = new Date(Date.UTC(year, month - 1, date));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date ? at : undefined;
}

/** The line the supervisor puts first on an owner's turn (the bots' prompts rely on its wording). */
export function ownerDateLine({ localDate, timeZone }: OwnerDate): string {
  const weekday = WEEKDAYS[dayOf(localDate)!.getUTCDay()];
  return `[TinyCloud: the owner's local date is ${weekday} ${localDate}, time zone ${timeZone}.]`;
}
