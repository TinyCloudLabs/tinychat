/** The owner's local calendar day and time zone, as the browser reports them. Display context only: never used to decide access or limits. */
export interface ClientContext {
  /** User-local calendar day, YYYY-MM-DD. */
  localDate: string;
  /** IANA time-zone name used to derive localDate. */
  timeZone: string;
}

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE = /^[A-Za-z0-9_+/-]{1,100}$/;

/** `value` as a ClientContext when it holds a real YYYY-MM-DD day and a time zone this runtime knows; anything else is undefined. */
export function clientContextFrom(value: unknown): ClientContext | undefined {
  if (!value || typeof value !== "object" || !("localDate" in value) || !("timeZone" in value)) return undefined;
  const { localDate, timeZone } = value;
  if (typeof localDate !== "string" || typeof timeZone !== "string" || !TIME_ZONE.test(timeZone)) return undefined;
  const day = LOCAL_DATE.exec(localDate);
  if (!day) return undefined;
  const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const at = new Date(Date.UTC(year, month - 1, date));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== date) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(at);
  } catch {
    return undefined;
  }
  return { localDate, timeZone };
}
