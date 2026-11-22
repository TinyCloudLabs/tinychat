// Every owner-visible word of Main's questions to the owner (TC-3595): the card in Main's chat and on Home, the
// chat lines after a decision, and the Settings toggle. Nothing else in the app writes these words.
// Monica's words (agent-ask-owner-words); Sam reviews them in parallel, and changes come as fast follow-ups.

/** The bot's name in every sentence below: one constant, so a rename is one edit. */
export const ASK_MAIN = "Main";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "less than a minute", "5 minutes", "3 hours", "1 hour 5 minutes": spelled out, as the card says "Asked … ago". */
export function askedAgo(elapsedMs: number): string {
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return "Asked less than a minute ago";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const parts = [hours > 0 ? plural(hours, "hour", "hours") : "", rest > 0 || hours === 0 ? plural(rest, "minute", "minutes") : ""];
  return `Asked ${parts.filter(Boolean).join(" ")} ago`;
}

export const ASK_STRINGS = {
  /** The Settings toggle. */
  toggleLabel: `Let ${ASK_MAIN} ask you questions`,
  toggleHelp: `${ASK_MAIN} can ask you a question in chat when it needs something from you. Off until you turn it on.`,
  toggleFailed: "Couldn’t save that, so the setting is unchanged. Try again.",

  /** The card. */
  asking: `${ASK_MAIN} is asking:`,
  quote: (question: string) => `“${question}”`,
  footer: `Your answer goes to ${ASK_MAIN} and the AI model service, like everything else in this chat.`,
  answerLabel: "Your answer",
  answerHint: `Don’t paste passwords or keys here. To give ${ASK_MAIN} access to an account, use Connectors.`,
  /** Shown under the answer box only while Web access is on. */
  webAccessOn: `Web access is on, so a page ${ASK_MAIN} reads could try to get it to send your answer to a website.`,
  /** Shown above the answer box only when the request says Main read something from outside the chat. */
  outside: `Before asking, ${ASK_MAIN} read something you didn’t write here, such as a web page, a meeting transcript or someone else’s message. Answer only if this question is what you expect.`,
  answer: "Answer",
  notNow: "Not now",
  stop: `Stop ${ASK_MAIN} from asking`,
  stopped: `${ASK_MAIN} won’t ask you questions. You can turn this back on in Settings.`,
  sendFailed: "Couldn’t send that. Try again.",
  gone: "This question can’t be answered any more.",

  /** What a card collapses to. */
  declined: "You said not now.",
  expired: "This question expired.",

  /** App-originated lines in the chat: shown to the owner, never taken for words the owner typed. */
  lineAnswered: `You answered ${ASK_MAIN}’s question.`,
  lineDeclined: `You said not now to ${ASK_MAIN}’s question.`,
  /** UI only: nothing is sent to Main when a question expires. */
  lineExpired: `${ASK_MAIN}’s question expired without an answer.`,
  /** UI only: shown once when the owner turns questions off, however many open questions and requests were closed. */
  lineStopped: `You turned off questions and requests from ${ASK_MAIN}, so its open questions and secret requests were closed.`,
} as const;

/** A secret's sites in a sentence: the service for a known secret, else the sites ("a and b", "a, b and c"). */
export function secretWith({ service, sites }: { service?: string; sites: string[] }): string {
  if (service) return service;
  return sites.length <= 1 ? sites.join("") : `${sites.slice(0, -1).join(", ")} and ${sites[sites.length - 1]}`;
}

/** "Sun 22 Nov, 13:12", in the owner's time zone. */
export function secretDate(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  return `${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

/**
 * Every owner-visible word of Main's secret requests: the card in Main's chat and on Home, the Feed row, and the chat
 * lines. A function that takes `name` returns parts, so the card can set the secret's name in code style.
 */
export const SECRET_STRINGS = {
  title: `${ASK_MAIN} is asking to use a secret`,
  onlyWith: ({ service, sites }: { service?: string; sites: string[] }) =>
    `Only with: ${service ? `${service} (${sites.join(", ")})` : sites.join(", ")}`,
  /** Only when the catalog lets Main write with it (Monica, 2026-11-22). Writes are for known secrets, so `with` is the service. */
  writes: (service: string) => `${ASK_MAIN} can also send data to ${service} with it, which may cost money or change things there.`,
  outside: `Before asking, ${ASK_MAIN} read something you didn’t write here, such as a web page, a meeting transcript or someone else’s message. Approve only if this request is what you expect.`,

  addTitle: "Add it to TinyCloud Secrets",
  addHelp: "You type the value there, not here. If it’s already there, this only checks that it is.",
  addButton: "Open TinyCloud Secrets",
  addDone: "In your TinyCloud Secrets",
  approveTitle: "Approve in OpenKey",
  approveHelp: `You choose how long ${ASK_MAIN} can use it: 1 hour unless you change it, up to 7 days.`,
  approveButton: "Approve in OpenKey",
  windowOpen: "Finish in the window that opened.",
  windowBlocked: "The window was blocked. Allow pop-ups for this page and try again.",
  footer: (sites: string) => `${ASK_MAIN} can use it only with ${sites} and can’t see or show its value.`,
  decline: "Decline",
  message: `Message ${ASK_MAIN}`,
  /** On iPhone, where TinyCloud Secrets can't open: shown with Decline only. */
  iphone: "To add or approve a secret, open TinyCloud One on the web or desktop.",

  needsYou: "Needs you",
  rowTitle: <N>(name: N) => [`${ASK_MAIN} is asking to use `, name],
  rowLine: (sites: string, asked: string) => `Only with ${sites} · ${asked.charAt(0).toLowerCase()}${asked.slice(1)} · `,
  openChat: "Open chat",

  approved: <N>(name: N, sites: string, until: string) => [`✓ ${ASK_MAIN} can use `, name, ` with ${sites} until ${until}.`],
  approvedHelp: "It can’t see or show the value. You can stop it sooner.",
  stopNow: "Stop now",
  close: "Close",
  cancel: "Cancel",
  stopConfirm: <N>(name: N) => [`Stop ${ASK_MAIN} using `, name, " now?"],
  stopConfirmHelp: `${ASK_MAIN} can’t use it after this. It stays in your TinyCloud Secrets.`,
  stopped: (name: string) => `Stopped. ${ASK_MAIN} can’t use ${name} any more.`,
  declined: "You declined. Nothing was shared.",
  expired: "This request expired. Nothing was shared.",
  nameOnlyWith: <N>(name: N, sites: string) => [name, ` · only with ${sites}`],
  ended: <N>(name: N, until: string) => [`${ASK_MAIN}’s access to `, name, ` ended on ${until}.`],
  endedHelp: `If ${ASK_MAIN} needs it again, you’ll see a new request.`,
  failed: <N>(name: N) => [`Something went wrong, so ${ASK_MAIN} can’t use `, name, " yet. Nothing was shared."],
  tryAgain: "Try again",

  /** App-originated lines in the chat. Expired and ended are UI only: nothing is sent to Main. */
  lineApproved: (name: string, sites: string, until: string) => `You let ${ASK_MAIN} use ${name} with ${sites} until ${until}.`,
  lineRevoked: (name: string) => `You stopped ${ASK_MAIN} using ${name}.`,
  lineDeclined: (name: string) => `You declined ${ASK_MAIN}’s request for ${name}.`,
  lineExpired: (name: string) => `${ASK_MAIN}’s request for ${name} expired.`,
  lineEnded: (name: string) => `${ASK_MAIN}’s access to ${name} ended.`,
} as const;
