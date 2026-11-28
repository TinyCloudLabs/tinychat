import type { AppPlatform } from "@/lib/platform";

export type ReportTrigger = "screenshot" | "menu";

/** The app facts a report carries; the person sees each of them under "See what we send". */
export interface ReportContext {
  /** The build line (buildInfo.ts). */
  app: string;
  platform: AppPlatform;
  /** The OS major version, phones only. */
  os?: string;
  /** The screen's id (shell/routes.ts), never its path: paths carry note and app ids. */
  screen: string;
  client_time: string;
  online: boolean;
  trigger: ReportTrigger;
}

/** iOS and Android major version from the WebView's user agent; undefined elsewhere. */
export function osMajor(platform: AppPlatform, userAgent: string): string | undefined {
  const match = platform === "ios" ? /\bOS (\d+)[_.]/.exec(userAgent) : platform === "android" ? /\bAndroid (\d+)/.exec(userAgent) : null;
  return match?.[1];
}

export interface RecentErrorLine { age_s: number; msg: string }

const KEEP = 20;
const SEND = 10;
/** Raw length kept per error; redaction runs on this, the 300-character cut after it (a cut first could split a secret). */
const RAW_CHARS = 2000;
export const ERROR_MSG_CHARS = 300;

interface Entry { at: number; text: string }

/** The last few uncaught errors, in memory only: name and message, never a stack. */
export function createErrorBuffer() {
  let entries: Entry[] = [];
  return {
    record(error: unknown, at: number) {
      const text = describe(error);
      if (!text) return;
      entries = [...entries.slice(1 - KEEP), { at, text: text.slice(0, RAW_CHARS) }];
    },
    /** The newest ten, newest first, each `redact`ed then cut to 300 characters. */
    recent(now: number, redact: (text: string) => string): RecentErrorLine[] {
      return entries.slice(-SEND).reverse().map((entry) => ({
        age_s: Math.max(0, Math.round((now - entry.at) / 1000)),
        msg: redact(entry.text).slice(0, ERROR_MSG_CHARS),
      }));
    },
    clear() { entries = []; },
  };
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message ? `${error.name}: ${error.message}` : error.name;
  if (typeof error === "string") return error;
  return "";
}

export const reportErrors = createErrorBuffer();

/** Feeds uncaught errors and unhandled rejections into `buffer`. Returns the uninstaller. */
export function installErrorCapture(target: Pick<Window, "addEventListener" | "removeEventListener">, buffer = reportErrors, now = Date.now): () => void {
  const onError = (event: Event) => buffer.record((event as ErrorEvent).error ?? (event as ErrorEvent).message, now());
  const onRejection = (event: Event) => buffer.record((event as PromiseRejectionEvent).reason, now());
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
