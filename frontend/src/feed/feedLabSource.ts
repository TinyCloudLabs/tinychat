// The feed lab's feed (FeedLab.tsx): seven made-up cards and a simulated agent, held in
// memory, in the shapes the real source returns (feedStore.ts, loadTypedFeed.ts).
// Nothing is read from or written to any space, server or browser storage. Each
// made-up agent says what it runs on (payload.agent), except Backup agent, which
// says nothing, so a card without a platform can be seen too.
import type { FeedCard, FeedHandling, FeedResponse, FeedResponseHandling, FeedResponsePayload, FeedSelector, FeedSource, NewFeedMessage, NewFeedResponse } from "@tinycloud/sdk-services/feed";
import { compactStamp, emptySitrepOwnerData, mergeSitrepStates, ownerThreadResponseKey, parseSitrepCardPayload, safeSitrepActionSummary, validateSitrepAction, type AskOption, type SamState, type SitrepHeldNote, type ThreadMessage } from "@tinyboilerplate/core/feed/sitrep";
import { ownerCardKey } from "./feedIdentity";
import type { HomeFeedEntry, HomeFeedSnapshot, HomeFeedSource, HomeFeedViewEvent } from "./feedStoreTypes";
import { addCanonicalOwnerEvent, combineOwnerData } from "./sitrepOwnerStore";
import type { LabPage } from "./PostPage";

/** A save takes this long, so its "in progress" state can be seen. */
export const LAB_SAVE_MS = 600;
/** After an answer is saved, the simulated agent records "acknowledged", then "succeeded". */
export const LAB_RECEIVED_MS = 1_500;
export const LAB_COMPLETED_MS = 6_000;
export const LAB_OUTCOME = "Done. The simulated agent acted on your answer.";
/** After a reply is saved, the simulated agent receives it, then answers in the card's conversation. */
export const LAB_REPLY_RECEIVED_MS = 1_000;
export const LAB_REPLY_MS = 2_000;
export const labReplyText = (text: string) => `Got it. I’ll act on “${text.length > 80 ? `${text.slice(0, 80)}…` : text}” and tell you here.`;

/** `route`: the agents the person approved a link to for the card's owner, as an owner archive supplies them. */
interface LabCard { source: FeedSource; card: FeedCard; route?: NonNullable<HomeFeedEntry["recipientRoute"]> }

function agent(token: string, label: string): FeedSource {
  const database = (side: string) => ({ spaceId: "feed-lab", database: `xyz.tinycloud.tinychat/feed/feed_${side}_lab${token}` });
  return { sourceId: `lab-${token}`, agentDid: `did:key:feed-lab-${token}`, label, output: database("output"), responses: database("responses") };
}

/** A one-page brief an agent attaches to a card (lab-only `payload.brief`, Sam 23:30Z); it opens in the app. */
const ROOM_BRIEF = { title: "Choosing the pottery workshop room", markdown: `## Background
The pottery workshop runs for four evenings next month, Tuesdays from 18:30 to 21:00. Two rooms are free on all four dates, and each is holding the booking for us.

## Why now
Both holds lapse in two days. **Fourteen people** have signed up, already more than the loft seats, and sign-ups stay open for another week.

## If you don't answer
No room is booked. The dates stay provisional, and I won't confirm places to the people who signed up.

## The options
| | The loft | The hall |
|---|---|---|
| Seats | 12 | 30 |
| Cost | 40 per evening | 65 per evening |
| Access | Two flights of stairs | Step-free |
| Light | North windows, good for glazing | Overhead lights |
| Catch | Already too small | The choir has it until 18:00 |

Waiting a week means asking again once sign-ups close, but both holds lapse before then.

## Recommendation
Book **the hall**. It fits everyone who has signed up with room to grow, and it is step-free, which two people asked about. The choir leaves at 18:00, so there are 30 minutes to set up. Over four evenings it costs 100 more than the loft.

- The wheels and the kiln cart fit through its double doors.
- Its tables can take clay, so no covers are needed.` };
const withRoomBrief = (card: FeedCard): FeedCard => ({ ...card, payload: { ...card.payload, brief: ROOM_BRIEF } });

function labCards(now: number): LabCard[] {
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const trip = agent("trip", "Trip agent");
  const home = agent("home", "Home agent");
  const backup = agent("backup", "Backup agent");
  const studio = agent("studio", "Studio agent");
  // One connection that posts for a crew: the card names the crew member it is from.
  const crew = agent("crew", "Studio crew");
  // What each agent reports about itself, as a card's payload.agent.
  type About = { agent: { kind: string; model?: string; runsOn?: string } };
  const codex: About = { agent: { kind: "codex", model: "GPT-5.2-Codex", runsOn: "Your laptop" } };
  const grok: About = { agent: { kind: "grok", model: "Grok 5", runsOn: "Grok Bot, in xAI's cloud" } };
  const claude: About = { agent: { kind: "claude", model: "Claude Opus 5.5", runsOn: "The studio's Mac mini" } };
  const muse: About = { agent: { kind: "muse", runsOn: "WhatsApp" } };
  const kiln = { recipientKey: "lab-kiln", legacyName: "Kiln agent", runtimeTarget: { agentId: "lab-kiln-agent" } };
  const plain = (cardId: string, urgency: number, minutes: number, card: Pick<FeedCard, "kind" | "needsResponse" | "title" | "body" | "choices" | "payload">): FeedCard => ({ cardId, revision: 1, issuanceId: "lab-1", urgency, createdAt: at(minutes), ...card });
  // A typed card as its agent publishes it: the record in payload.sitrep, its title, body and options on the card.
  const typed = (cardId: string, urgency: number, minutes: number, record: { kind: string; title: string; body: string; options?: AskOption[] } & Record<string, unknown>, about: About = claude): FeedCard => {
    const createdAt = at(minutes);
    return {
      cardId, revision: 1, issuanceId: "lab-1", kind: record.kind, needsResponse: true, title: record.title, body: record.body, urgency, createdAt,
      ...(record.options ? { choices: record.options.map(({ id, label }) => ({ id, label })) } : {}),
      payload: { ...about, sitrep: { version: 1, record: { from: studio.label, urgency, importance: 3, links: [], createdAt, updatedAt: createdAt, ...record } } },
    };
  };
  return withSummaries([
    { source: trip, card: plain("lab-train", 5, -4, {
      kind: "question", needsResponse: true, title: "Which train should I hold for Friday?",
      body: "Two trains reach the workshop before it starts at 14:00. Holding a seat is free until Thursday.",
      // Lab-only fields (Sam, 23:30Z): priority 0 (highest) to 5, a deadline, a "relevant until".
      choices: [{ id: "direct", label: "08:15 direct" }, { id: "change", label: "09:40, one change" }], payload: { ...codex, priority: 1, deadline: at(3 * 24 * 60) },
    }) },
    { source: home, card: plain("lab-filter", 4, -35, {
      kind: "question", needsResponse: true, title: "The water filter order renews tomorrow. Keep it?",
      body: "It has renewed every two months since spring. The last filter is still unopened.",
      choices: [{ id: "renew", label: "Renew" }, { id: "skip", label: "Skip this one" }, { id: "stop", label: "Stop it" }], payload: { ...grok, priority: 2, expiresAt: at(20 * 60) },
    }) },
    // Past its "relevant until": not in the feed, only in History, marked expired.
    { source: home, card: plain("lab-expired-parcel", 3, -300, {
      kind: "question", needsResponse: true, title: "Can a neighbour sign for the parcel at 14:00?",
      body: "The courier asked before the 14:00 slot. That slot has passed.",
      choices: [{ id: "yes", label: "Yes, ask next door" }, { id: "no", label: "No, redeliver" }], payload: { ...grok, priority: 3, expiresAt: at(-30) },
    }) },
    { source: backup, card: plain("lab-backup", 1, -90, {
      kind: "update", needsResponse: false, title: "Weekly backup finished",
      body: "312 new photos and 18 documents are stored. Nothing needs you.", payload: { priority: 5 },
    }) },
    { source: studio, card: typed("lab-letter", 3, -20, {
      kind: "ask", id: "newsletter-version", title: "Which version of the spring newsletter goes out?", body: "Both drafts are finished and checked.",
      askedAt: at(-20), status: "open", expiresAt: "never", recommend: "short",
      options: [
        { id: "short", label: "Short version", detail: "Three paragraphs and the dates. Ready to send today." },
        { id: "long", label: "Long version", detail: "Adds the member interview. Needs one more day of edits." },
      ],
      context: {
        background: "The spring newsletter has two finished drafts. The short one covers the open day and the new opening hours; the long one adds an interview with a member.",
        whyNow: "The mailing is booked for tomorrow morning, so the choice is needed today.",
        ifNoAnswer: "The short version goes out tomorrow at 09:00.",
        known: ["The last three newsletters were short, and about half the list opened them."], related: [],
      },
    }) },
    { source: studio, card: withRoomBrief(typed("lab-room", 3, -50, {
      kind: "ask", id: "workshop-room", title: "Which room should I book for the pottery workshop?", body: "Fourteen people have signed up so far.",
      askedAt: at(-50), status: "open", expiresAt: "never", recommend: "hall", deadline: at(2 * 24 * 60),
      options: [
        { id: "loft", label: "The loft", detail: "Seats 12, good light, two flights of stairs.", cost: "40 per evening" },
        { id: "hall", label: "The hall", detail: "Seats 30, step-free, shared with the choir until 18:00.", cost: "65 per evening" },
        { id: "wait", label: "Wait a week", detail: "Ask again once sign-ups close." },
      ],
      context: {
        background: "The pottery workshop runs for four evenings next month. Two rooms are free on those dates, and each holds its booking for two more days.",
        whyNow: "Both rooms release their hold in two days, and sign-ups already exceed the loft's seats.",
        ifNoAnswer: "No room is booked and the workshop dates stay provisional.",
        known: ["Sign-ups close in one week."], related: [],
      },
    })) },
    { source: studio, card: typed("lab-prices", 2, -10, {
      kind: "approval", id: "price-list-go", title: "Publish the spring price list", body: "Two prices changed; the rest are as they were.",
      approvalType: "go", approvalKind: "publish", codeExpected: false, issuedAt: at(-10), expiresAt: at(3 * 24 * 60), status: "open",
      permissions: "Publishing replaces the price list on the studio's page for everyone.",
      steps: ["Read the two changed prices: glazing goes up by 2, firing stays the same.", "Give the go when they are right."],
      context: {
        background: "The spring price list is drafted and checked against last season's. Only the glazing price changed; the page still shows the winter list.",
        whyNow: "Spring bookings open in three days and should show the new prices.",
        ifNoAnswer: "The winter price list stays on the page.",
        known: [], related: [],
      },
    }) },
    // The person approved a link to Kiln agent, so a reply goes straight to it rather than through Studio crew.
    { source: crew, route: { recipients: [kiln], unresolved: [], receiptRecipients: [kiln] }, card: typed("lab-glaze", 3, -15, {
      kind: "ask", id: "open-day-glaze", from: "Kiln agent", title: "Which glaze should the open-day mugs get?", body: "Forty mugs are bisque-fired and ready to glaze.",
      askedAt: at(-15), status: "open", expiresAt: "never", recommend: "celadon",
      options: [
        { id: "celadon", label: "Celadon", detail: "Pale green, the studio's usual. Glaze firing on Tuesday." },
        { id: "speckled", label: "Speckled white", detail: "New for spring. Needs one test firing first, so Thursday." },
      ],
      context: {
        background: "The mugs are for the open day in two weeks. Both glazes are in stock.",
        whyNow: "The kiln is booked from Tuesday; a test firing has to go in before then.",
        ifNoAnswer: "The mugs get celadon on Tuesday.",
        known: [], related: [],
      },
    }, muse) },
    // Posts (Sam, 11-12): an image and a blurb in the feed, the whole page on tap, answered at its bottom.
    ...PAGES.map((page) => ({ source: page.crew ? crew : studio, card: plain(page.cardId, page.urgency, page.minutes, {
      kind: "page", needsResponse: true, title: page.title, body: page.body, payload: { ...(page.crew ? muse : claude), summary: page.summary, page: page.page },
    }) })),
    // Updates with nothing to decide: what the "Information" view shows.
    { source: studio, card: plain("lab-info-firing", 1, -60, {
      kind: "update", needsResponse: false, title: "The kiln firing finished overnight",
      body: "It reached temperature at 03:40 and cools until 14:00. Nothing cracked.", payload: claude,
    }) },
    { source: trip, card: plain("lab-info-tickets", 1, -140, {
      kind: "update", needsResponse: false, title: "Tickets for the 3rd are in your email",
      body: "Both tickets are in the travel folder too. Seat 42, coach C.", payload: codex,
    }) },
  ]);
}

// Each made-up card's short description, the one or two lines the compact view shows (Sam, 11-12: "like a Twitter
// description"). In the real feed this would be a new optional card field, `payload.summary`; the agents' guide
// would have to name it. Without one, the compact view shows the start of the body.
const SUMMARIES: Record<string, string> = {
  "lab-train": "08:15 direct or 09:40 with a change. Holding a seat is free until Thursday.",
  "lab-filter": "It renews tomorrow, and the last filter is still unopened.",
  "lab-backup": "312 photos and 18 documents stored. Nothing needs you.",
  "lab-letter": "Short or long spring newsletter. The mailing goes out tomorrow at 09:00.",
  "lab-room": "The loft seats 12, the hall 30. Both hold the dates for two more days.",
  "lab-prices": "Glazing goes up by 2, firing stays the same. Bookings open in three days.",
  "lab-glaze": "Celadon on Tuesday, or speckled white after a test firing on Thursday.",
  "lab-info-firing": "It cools until 14:00. Nothing cracked.",
  "lab-info-tickets": "In the travel folder too. Seat 42, coach C.",
};
function withSummaries(cards: LabCard[]): LabCard[] {
  return cards.map((labCard) => SUMMARIES[labCard.card.cardId] ? { ...labCard, card: { ...labCard.card, payload: { ...labCard.card.payload, summary: SUMMARIES[labCard.card.cardId] } } } : labCard);
}

// The lab's posts, each with its page (PostPage.tsx). Media is in public/lab-media. Times are minutes from now.
const PAGES: { cardId: string; urgency: number; minutes: number; crew?: true; title: string; body: string; summary: string; page: LabPage }[] = [
  {
    cardId: "lab-page-film", urgency: 4, minutes: -6, title: "Open-day film, cut 2: the kiln opening is new",
    body: "Your notes on cut 1 asked to see the kiln open. Cut 2 opens its door at 0:01 and ends on the time. The rest is as before.\n\nWhat I need: an OK, or a note on what to change.",
    summary: "Six seconds. The kiln door now opens on screen, and the film ends on the time.",
    page: {
      image: "/lab-media/kiln-poster.jpg", imageAlt: "The kiln open and glowing, with five glazed mugs inside",
      questions: [
        { id: "film", header: "Cut 2", question: "The whole film, 6 s. The door opening (from 0:01) is new.", media: [
          { type: "video", src: "/lab-media/kiln-film.mp4", poster: "/lab-media/kiln-poster.jpg", caption: "Open-day film, cut 2" },
          { type: "image", src: "/lab-media/kiln-contact.jpg", caption: "One frame every half second" },
        ], options: [{ label: "OK" }, { label: "Change (see note)" }] },
        { id: "else", header: "Anything else", question: "Anything else on the film?" },
      ],
    },
  },
  {
    cardId: "lab-page-flyer", urgency: 3, minutes: -25, title: "Open-day flyer: three covers to choose from",
    body: "The printer needs the cover by Friday. All three have the same date, times and words; only the picture and the type change. I'd pick the kiln arch, which matches the film.",
    summary: "The kiln arch, the mugs or the glaze grid. The printer needs one by Friday.",
    page: {
      image: "/lab-media/flyers-hero.svg", imageAlt: "Three flyer covers side by side",
      questions: [
        { id: "cover", header: "Cover", question: "Which cover goes to the printer?", options: [
          { label: "The kiln arch", recommended: true, description: "Warm orange, with the kiln door as the picture. Matches the film.", image: "/lab-media/flyer-a.svg" },
          { label: "Make a mug", description: "Four mugs on a shelf. The friendliest of the three.", image: "/lab-media/flyer-b.svg" },
          { label: "The glaze grid", description: "Six glaze colours and plain type. The calmest.", image: "/lab-media/flyer-c.svg" },
        ] },
        { id: "else", header: "Anything else", question: "Anything else on the flyer?" },
      ],
    },
  },
  {
    cardId: "lab-page-tiles", urgency: 2, minutes: -70, crew: true, title: "Glaze test tiles: tap every one you like",
    body: "Four test tiles came out of Thursday's firing. Your picks decide which glazes go on the open-day shelf.",
    summary: "Celadon, speckled white, tenmoku and cobalt, fresh from Thursday's firing.",
    page: {
      image: "/lab-media/glazes-hero.svg", imageAlt: "Four glaze test tiles in a row",
      questions: [
        { id: "tiles", header: "Test tiles", question: "Which glazes go on the open-day shelf? Tap every one you like.", multi: true, notePrompt: "Note (optional): what you like or don't, and why", options: [
          { label: "Celadon", image: "/lab-media/glaze-1.svg" },
          { label: "Speckled white", image: "/lab-media/glaze-2.svg" },
          { label: "Tenmoku", image: "/lab-media/glaze-3.svg" },
          { label: "Cobalt", image: "/lab-media/glaze-4.svg" },
        ] },
        { id: "else", header: "Anything else", question: "Anything else on the glazes?" },
      ],
    },
  },
];
// More made-up updates for the infinite scroll, so it mixes them in with the questions.
const MORE_UPDATES: { title: string; body: string; summary: string }[] = [
  { title: "The clay order shipped", body: "Two boxes, arriving on Wednesday before noon.", summary: "Two boxes, on Wednesday before noon." },
  { title: "Next week's calendar is set", body: "Three bookings moved to fit the workshop evenings. Nothing clashes now.", summary: "Three bookings moved to fit the workshop." },
  { title: "The studio's Wi-Fi is back", body: "It was down for 20 minutes and came back at 11:20 after a restart. Nothing was lost.", summary: "Down for 20 minutes, back at 11:20. Nothing lost." },
];
// More made-up questions for the lab's infinite scroll, posted ever earlier as you scroll down. Agents cycle.
const MORE_QUESTIONS: { title: string; body: string; summary: string; choices: string[] }[] = [
  { title: "Move the dentist appointment to Tuesday?", body: "The clinic offered 10:30 on Tuesday. Your calendar is clear then.", summary: "10:30 on Tuesday is free in your calendar.", choices: ["Yes, Tuesday", "Keep Thursday"] },
  { title: "Renew the domain for two years?", body: "It expires in 12 days. Two years costs 24, one year 13.", summary: "It expires in 12 days. Two years cost 24, one year 13.", choices: ["Two years", "One year"] },
  { title: "Which photo goes on the studio's front page?", body: "Three photos from the spring open day are ready.", summary: "Three photos from the open day: the kiln, the wheel room or the mugs.", choices: ["The kiln", "The wheel room", "The mugs"] },
  { title: "Order more clay before the price rises?", body: "The supplier raises prices on the 1st. Stock lasts about three weeks.", summary: "Prices rise on the 1st. Stock lasts about three weeks.", choices: ["Order now", "Wait"] },
  { title: "Reply to the hall about the choir's dates?", body: "They asked whether the studio still needs the hall on Thursdays.", summary: "The hall asks whether the studio still needs Thursdays.", choices: ["Keep Thursdays", "Release them"] },
  { title: "Book the van for the market?", body: "The market is on the 23rd. The van is free that day.", summary: "The market is on the 23rd, and the van is free.", choices: ["Book it", "Not this time"] },
];
// Questions you answered earlier, shown when you pull down at the top of the feed. Times go back from now.
const ANSWERED: { title: string; body: string; summary: string; choices: string[]; chose: number }[] = [
  { title: "Which train should I hold for the 3rd?", body: "Two trains reach the meeting in time.", summary: "Two trains reach the meeting in time.", choices: ["07:50 direct", "08:40, one change"], chose: 0 },
  { title: "Pay the October hosting invoice?", body: "214.60, due on the 15th. Same as last month.", summary: "214.60, due on the 15th. Same as last month.", choices: ["Pay it", "Hold for review"], chose: 0 },
  { title: "Keep the gym membership?", body: "It renews on the 1st. You went four times last month.", summary: "It renews on the 1st; four visits last month.", choices: ["Keep it", "Cancel it"], chose: 1 },
  { title: "Which cover for the newsletter?", body: "Two covers are ready.", summary: "The garden or the kiln.", choices: ["The garden", "The kiln"], chose: 1 },
  { title: "Accept the call with the supplier at 15:00?", body: "They want to talk about delivery dates.", summary: "They want to talk about delivery dates.", choices: ["Accept", "Ask for tomorrow"], chose: 0 },
];

/** `stop` cancels the simulated agent's pending work; the lab calls it when it resets or closes. */
export function createFeedLabSource(now = Date.now()): HomeFeedSource & { stop(): void } {
  const cards = labCards(now);
  // Cards you answered earlier, made as you pull down for them; they load as the feed's history.
  const archived: LabCard[] = [];
  // The agent's replies to your comments on plain cards, as `payload.replies` on the card. `replyTo` is the id of the
  // comment answered (Sam, 11-12: the agent replies to something you said, like iMessage). The real feed has no
  // such field on a reply yet: it would need a reply-to reference on agent replies.
  const plainReplies = new Map<string, { text: string; at: string; replyTo?: string }[]>();
  let more = 0;
  const saved: { response: FeedResponse; payload?: FeedResponsePayload }[] = [];
  const handling = new Map<string, FeedResponseHandling>();
  // A conversation already under the water filter card: two of your comments, the first answered twice, the
  // second once, each reply pointing at its comment.
  {
    const filter = cards.find((labCard) => labCard.card.cardId === "lab-filter")!;
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    // `acknowledged: false`: the agent never confirmed it got the comment, so it shows "Not confirmed" and "Send again".
    const comment = (text: string, minutes: number, acknowledged = true) => {
      const response: FeedResponse = { responseId: crypto.randomUUID(), cardId: filter.card.cardId, revision: filter.card.revision, issuanceId: filter.card.issuanceId, kind: "message", text, createdAt: at(minutes), sequence: saved.length + 1 };
      saved.push({ response });
      if (acknowledged) handling.set(response.responseId, { acknowledgement: { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: crypto.randomUUID(), phase: "acknowledged", createdAt: at(minutes + 0.5) }, outcome: null });
      return response.responseId;
    };
    const wait = comment("Can it wait until the next order on the 3rd?", -32);
    comment("Could you also cancel last month's spare?", -29, false);
    const left = comment("How many filters do we have left?", -27);
    // The first comment's second reply comes after the second comment, so it quotes the comment it answers.
    plainReplies.set(ownerCardKey(filter.source.sourceId, filter.card), [
      { text: "It can. Skipping now moves the order to the 3rd, with no fee.", at: at(-31), replyTo: wait },
      { text: "One, unopened, in the hall cupboard.", at: at(-26), replyTo: left },
      { text: "Got it. The unopened filter lasts until the next order.", at: at(-25), replyTo: wait },
    ]);
  }
  const views = new Map<string, { seenAt?: string; snoozedUntil?: string; events: HomeFeedViewEvent[] }>();
  const states = new Map<string, { eventId: string; state: SamState }[]>();
  const heldNotes = new Map<string, SitrepHeldNote[]>();
  // The simulated agent's replies, by card, as the real feed attaches its output cards (feedStore.ts).
  const replies = new Map<string, ThreadMessage[]>();
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  // "All" (Sam, 11-12: one feed that mixes posts, decisions and updates).
  let defaultSelector: FeedSelector = "both";

  const keyOf = (entry: HomeFeedEntry) => ownerCardKey(entry.source.sourceId, entry.state.card);
  const viewOf = (key: string) => views.get(key) ?? views.set(key, { events: [] }).get(key)!;
  function later(ms: number, work: () => void) {
    const timer = setTimeout(() => { timers.delete(timer); work(); }, ms);
    timers.add(timer);
  }
  const wait = (ms: number) => new Promise<void>((resolve) => later(ms, resolve));
  function notify() { for (const listener of listeners) listener(); }

  function entryOf({ source, card: posted, route }: LabCard): HomeFeedEntry {
    const key = ownerCardKey(source.sourceId, posted);
    // The agent's replies to your comments show on the card itself, as a plain card carries them.
    const answered = plainReplies.get(key);
    const card = answered ? { ...posted, payload: { ...posted.payload, replies: answered } } : posted;
    const history = saved.filter(({ response }) => ownerCardKey(source.sourceId, response) === key);
    const latest = history.filter(({ response }) => response.kind !== "message").at(-1)?.response ?? null;
    const receipt = latest ? handling.get(latest.responseId) : undefined;
    const view = viewOf(key);
    const entry: HomeFeedEntry = {
      source, currentIssuance: true,
      state: { card, response: latest, acknowledgement: receipt?.acknowledgement ?? null, outcome: receipt?.outcome ?? null },
      view: { sourceId: source.sourceId, cardId: card.cardId, revision: card.revision, issuanceId: card.issuanceId, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(view.snoozedUntil ? { snoozedUntil: view.snoozedUntil } : {}) },
      responses: history.map(({ response }) => response), viewEvents: view.events,
      // Each response's receipt, as the real store attaches it, so a comment shows "<agent> received" too.
      responseHandling: Object.fromEntries(history.flatMap(({ response }) => { const reported = handling.get(response.responseId); return reported ? [[response.responseId, reported] as const] : []; })),
    };
    const typed = parseSitrepCardPayload(card.payload?.sitrep);
    if (!typed) return entry;
    // As loadTypedFeed.ts: the owner's typed history, each response's receipt, and seen and snoozed in the owner state.
    const owner = emptySitrepOwnerData();
    for (const event of states.get(key) ?? []) {
      owner.states.push(event.state);
      if (event.state.doneAt || event.state.lift || event.state.clears?.length) (owner.commands ??= []).push(event);
    }
    if (heldNotes.has(key)) owner.heldNotes = heldNotes.get(key);
    // As loadTypedFeed.ts: each message keeps the route it was sent on.
    const threadRoutes: NonNullable<HomeFeedEntry["threadRoutes"]> = {};
    for (const { response, payload } of history) {
      const decoded = payload && addCanonicalOwnerEvent(owner, entry, response, payload);
      if (decoded) threadRoutes[ownerThreadResponseKey(decoded.message)] = decoded.delivery ? { kind: "recipients", delivery: decoded.delivery } : { kind: "publisher" };
    }
    for (const reply of replies.get(key) ?? []) {
      owner.threads.push(reply);
      (owner.threadOrigins ??= {})[ownerThreadResponseKey(reply)] = { kind: "agent-output", sourceId: source.sourceId, cardId: `lab-reply-${reply.messageId}`, revision: 1, issuanceId: "lab-1" };
    }
    const state: SamState = mergeSitrepStates(owner.states, "provided")[0] ?? { kind: typed.record.kind, id: typed.record.id, steps: {}, updatedAt: view.seenAt ?? card.createdAt };
    const snoozes = view.events.flatMap((event) => event.kind === "snoozed" && event.snoozedUntil ? [{ at: event.createdAt, until: event.snoozedUntil }] : []);
    if (owner.states.length || view.seenAt || snoozes.length) owner.states = [{ ...state, ...(view.seenAt ? { seenAt: view.seenAt } : {}), ...(snoozes.length ? { snoozedUntil: view.snoozedUntil ?? null, snoozes } : {}) }];
    const receipts = history.flatMap(({ response }) => { const reported = handling.get(response.responseId); return reported ? [[response.responseId, reported] as const] : []; });
    return { ...entry, owner: combineOwnerData([owner]), responseHandling: Object.fromEntries(receipts), threadRoutes, historicalCommands: [], ...(route ? { recipientRoute: structuredClone(route) } : {}) };
  }

  async function store(entry: HomeFeedEntry, response: NewFeedResponse | NewFeedMessage, payload?: FeedResponsePayload): Promise<FeedResponse> {
    if (payload?.type.startsWith("sitrep.")) {
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      if (!typed || payload.version !== 1) throw new Error("Unsupported typed Home response");
      response = { ...response, text: safeSitrepActionSummary(validateSitrepAction(typed.record, payload.type, payload.data, new Date().toISOString())) };
    }
    await wait(LAB_SAVE_MS);
    const stored: FeedResponse = { ...response, sequence: saved.length + 1, ...(payload ? { payloadType: payload.type, payloadVersion: payload.version } : {}) };
    saved.push({ response: stored, ...(payload ? { payload } : {}) });
    return stored;
  }
  function report(response: FeedResponse, phase: FeedHandling["phase"], detail?: FeedHandling["detail"]) {
    const record: FeedHandling = { cardId: response.cardId, revision: response.revision, issuanceId: response.issuanceId, responseId: response.responseId, handlingId: crypto.randomUUID(), phase, createdAt: new Date().toISOString(), ...(detail ? { detail } : {}) };
    const previous = handling.get(response.responseId) ?? { acknowledgement: null, outcome: null };
    handling.set(response.responseId, phase === "acknowledged" ? { ...previous, acknowledgement: record } : { ...previous, outcome: record });
    notify();
  }

  return {
    async load(focused) {
      const entries = cards.map(entryOf);
      const focusedEntry = focused ? entries.find((entry) => keyOf(entry) === keyOf(focused)) : undefined;
      const snapshot: HomeFeedSnapshot = { entries, historicalEntries: archived.map(entryOf), settings: { defaultSelector }, sitrep: combineOwnerData(entries.flatMap((entry) => entry.owner ? [entry.owner] : [])), relatedEntries: [], ...(focusedEntry ? { focusedEntry } : {}) };
      return structuredClone(snapshot);
    },
    async saveResponse(entry, response, payload) {
      const stored = await store(entry, response, payload);
      later(LAB_RECEIVED_MS, () => report(stored, "acknowledged"));
      later(LAB_COMPLETED_MS, () => report(stored, "succeeded", { message: LAB_OUTCOME }));
      return stored;
    },
    async sendMessage(entry, message, payload) {
      const stored = await store(entry, message, payload);
      const typed = parseSitrepCardPayload(entry.state.card.payload?.sitrep);
      const sent = payload?.type === "sitrep.thread" ? payload.data as { text?: unknown; messageId?: unknown } : undefined;
      if (typed && typeof sent?.text === "string" && typeof sent.messageId === "string") {
        const { text, messageId } = sent;
        later(LAB_REPLY_RECEIVED_MS, () => report(stored, "acknowledged"));
        later(LAB_REPLY_MS, () => {
          const at = new Date().toISOString();
          const reply: ThreadMessage = { side: "officer", kind: typed.record.kind, id: typed.record.id, at, from: typed.record.from, text: labReplyText(text), replyTo: messageId, messageId: `${compactStamp(at)}-${crypto.randomUUID().replace(/-/g, "")}` };
          replies.set(keyOf(entry), [...(replies.get(keyOf(entry)) ?? []), reply]);
          notify();
        });
      }
      // A comment on a plain card: the agent receives it, then replies under it on the card.
      if (!typed && message.text) {
        const text = message.text;
        later(LAB_REPLY_RECEIVED_MS, () => report(stored, "acknowledged"));
        later(LAB_REPLY_MS, () => {
          plainReplies.set(keyOf(entry), [...(plainReplies.get(keyOf(entry)) ?? []), { text: labReplyText(text), at: new Date().toISOString(), replyTo: stored.responseId }]);
          notify();
        });
      }
      return stored;
    },
    async saveOwnerState(entry, event) { states.set(keyOf(entry), [...(states.get(keyOf(entry)) ?? []), structuredClone(event)]); notify(); },
    async saveHeldNote(entry, note) { heldNotes.set(keyOf(entry), [...(heldNotes.get(keyOf(entry)) ?? []), structuredClone(note)]); notify(); },
    async markSeen(entry) {
      const view = viewOf(keyOf(entry));
      view.seenAt = new Date().toISOString();
      view.events.push({ sequence: view.events.length + 1, kind: "seen", createdAt: view.seenAt });
    },
    async snooze(entry, until) {
      const view = viewOf(keyOf(entry));
      view.snoozedUntil = until;
      view.events.push({ sequence: view.events.length + 1, kind: "snoozed", createdAt: new Date().toISOString(), snoozedUntil: until });
    },
    async setDefaultSelector(selector) { defaultSelector = selector; },
    async loadMore() {
      const agents = [agent("trip", "Trip agent"), agent("home", "Home agent"), agent("studio", "Studio agent")];
      for (let index = 0; index < 4; index++, more++) {
        const source = agents[more % agents.length]!;
        const createdAt = new Date(now - (120 + more * 37) * 60_000).toISOString();
        const base = { cardId: `lab-more-${more}`, revision: 1, issuanceId: "lab-1", urgency: 0, createdAt };
        // Every fourth card is an update, so the scroll mixes them in. The three posts appear once, at the top
        // (design critique #4: the same posts repeated at the end).
        if (more % 4 === 3) {
          const update = MORE_UPDATES[Math.floor(more / 4) % MORE_UPDATES.length]!;
          cards.push({ source, card: { ...base, kind: "update", needsResponse: false, title: update.title, body: update.body, payload: { summary: update.summary } } });
        } else {
          const question = MORE_QUESTIONS[more % MORE_QUESTIONS.length]!;
          cards.push({ source, card: { ...base, kind: "question", needsResponse: true, title: question.title, body: question.body, payload: { summary: question.summary },
            choices: question.choices.map((label, choice) => ({ id: `c${choice}`, label })) } });
        }
      }
      notify();
    },
    async loadAnswered(before, limit) {
      const agents = [agent("trip", "Trip agent"), agent("home", "Home agent"), agent("backup", "Backup agent")];
      const start = before ? Date.parse(before) : now - 2 * 3_600_000;
      const made: LabCard[] = [];
      for (let index = 0; index < limit; index++) {
        const number = archived.length;
        const template = ANSWERED[number % ANSWERED.length]!;
        const answeredAt = start - (index + 1) * 150 * 60_000;
        const card: FeedCard = {
          cardId: `lab-answered-${number}`, revision: 1, issuanceId: "lab-1", kind: "question", needsResponse: true, urgency: 0,
          createdAt: new Date(answeredAt - 20 * 60_000).toISOString(), title: template.title, body: template.body, payload: { summary: template.summary },
          choices: template.choices.map((label, choice) => ({ id: `c${choice}`, label })),
        };
        const labCard = { source: agents[number % agents.length]!, card };
        archived.push(labCard); made.push(labCard);
        const response: FeedResponse = { responseId: crypto.randomUUID(), cardId: card.cardId, revision: 1, issuanceId: "lab-1", kind: "answer", choiceId: `c${template.chose}`, createdAt: new Date(answeredAt).toISOString(), sequence: saved.length + 1 };
        saved.push({ response });
        const reported = (phase: FeedHandling["phase"], ms: number): FeedHandling => ({ cardId: card.cardId, revision: 1, issuanceId: "lab-1", responseId: response.responseId, handlingId: crypto.randomUUID(), phase, createdAt: new Date(answeredAt + ms).toISOString(), ...(phase === "succeeded" ? { detail: { message: LAB_OUTCOME } } : {}) });
        handling.set(response.responseId, { acknowledgement: reported("acknowledged", 15_000), outcome: reported("succeeded", 60_000) });
      }
      return structuredClone(made.map(entryOf));
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    stop() { for (const timer of timers) clearTimeout(timer); timers.clear(); },
  };
}
