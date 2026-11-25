// Main's questions and proposals as cards. The question, choices and proposed message come from the box, so they are
// only ever rendered as text children: no markup, links or images, and hidden or direction-changing characters are
// removed first (askText.ts). A proposal card is made from its fields alone; the bot writes none of the card's words.
import { Fragment, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ActionRequest, AskRequest, FeedbackReport, SecretLine } from "./botsApi";
import { ACTION_STRINGS, joinNames } from "./actionStrings";
import { FEEDBACK_STRINGS, feedbackOutcomeText } from "./feedbackStrings";
import { ASK_STRINGS as COPY, SECRET_STRINGS, askedAgo, secretDate, secretWith } from "./askStrings";
import { MAX_ANSWER, MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, plainLines, plainText } from "./askText";
import { actionNames, type Asks } from "./useAsks";

/** The longest proposed message the service keeps; anything longer is cut where the card shows it. */
const MAX_ACTION_TEXT = 2000;
/** The longest report title and field the service keeps. */
const MAX_FEEDBACK_TITLE = 120;
const MAX_FEEDBACK_FIELD = 800;

const MINUTE_MS = 60_000;

function AskCard({ request, asks }: { request: AskRequest; asks: Asks }) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);

  const question = plainText(request.question ?? "", MAX_QUESTION);
  const choices = (request.choices ?? []).slice(0, MAX_CHOICES).flatMap((choice, index) => {
    const label = plainText(choice, MAX_CHOICE);
    return label ? [{ index, label }] : [];
  });
  const text = answer.trim();

  const submit = async (decision: Parameters<Asks["decide"]>[1]) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await asks.decide(request, decision);
    // On success the card is gone; on failure it stays, and the next read of the requests says whether it still can be answered.
    setBusy(false);
    if (result === "failed") setFailed(true);
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-ask-card=""
      data-ask-id={request.id}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <p id={`${id}-title`} className="text-headline">{COPY.asking}</p>
      <p className="whitespace-pre-wrap break-words text-body" data-ask-question="">{COPY.quote(question)}</p>
      <p className="text-callout text-muted-foreground">{askedAgo(now - Date.parse(request.askedAt))}</p>
      {request.outside ? <p className="text-callout" data-ask-outside="">{COPY.outside}</p> : null}
      <p className="text-callout text-muted-foreground">{COPY.footer}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text) void submit({ decision: "answer", answer: text });
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="sr-only">{COPY.answerLabel}</span>
          <textarea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            maxLength={MAX_ANSWER}
            rows={2}
            disabled={busy}
            aria-describedby={`${id}-hint`}
            className="block w-full resize-y rounded-xl border border-input bg-transparent px-3 py-2 text-body text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <p id={`${id}-hint`} className="text-callout text-muted-foreground">{COPY.answerHint}</p>
        {asks.webOn ? <p className="text-callout text-muted-foreground" data-ask-web="">{COPY.webAccessOn}</p> : null}
        {choices.length > 0 ? (
          <div className="flex flex-wrap gap-2" data-ask-choices="">
            {choices.map(({ index, label }) => (
              <Button key={index} type="button" variant="outline" disabled={busy} onClick={() => void submit({ decision: "answer", choice: index })}>
                {label}
              </Button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !text}>{COPY.answer}</Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void submit({ decision: "decline" })}>{COPY.notNow}</Button>
        </div>
      </form>
      {failed ? <p role="alert" className="text-callout text-muted-foreground">{COPY.sendFailed}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => { setBusy(true); void asks.stop().then((result) => { setBusy(false); if (result === "failed") setFailed(true); }); }}
        className="self-start text-callout text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {COPY.stop}
      </button>
    </section>
  );
}

/**
 * One proposal: who it goes to, Main's message as written, and Send or Don't send. Send names the binding the
 * service gave with this card, so only this message to these bots can go.
 */
function ActionCard({ request, asks }: { request: ActionRequest; asks: Asks }) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);

  const names = actionNames(request).map((name) => plainText(name, 120) || ACTION_STRINGS.missing);
  const message = plainLines(request.text ?? "", MAX_ACTION_TEXT);
  const binding = request.binding;

  const submit = async (decision: Parameters<Asks["decide"]>[1]) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await asks.decide(request, decision);
    setBusy(false);
    if (result === "failed") setFailed(true);
    if (result === "held") setHeld(true);
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-action-card=""
      data-ask-id={request.id}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <p id={`${id}-title`} className="text-headline">{ACTION_STRINGS.title(joinNames(names))}</p>
      <p className="text-callout text-muted-foreground">{ACTION_STRINGS.label}</p>
      <p className="whitespace-pre-wrap break-words rounded-xl border border-border px-3 py-2 text-body" data-action-text="">{message}</p>
      <p className="text-callout text-muted-foreground">{askedAgo(now - Date.parse(request.askedAt))}</p>
      {request.outside ? <p className="text-callout" data-action-outside="">{ACTION_STRINGS.outside}</p> : null}
      <p className="text-callout text-muted-foreground">{ACTION_STRINGS.footer}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || held || !binding || !message} onClick={() => { if (binding) void submit({ decision: "approve", binding }); }}>{ACTION_STRINGS.send}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void submit({ decision: "decline" })}>{ACTION_STRINGS.decline}</Button>
      </div>
      {failed ? <p role="alert" className="text-callout text-muted-foreground">{ACTION_STRINGS.sendFailed}</p> : null}
      {held ? <p role="alert" className="text-callout" data-action-held="">{ACTION_STRINGS.held}</p> : null}
    </section>
  );
}

const FEEDBACK_FIELDS = [
  ["title", FEEDBACK_STRINGS.labels.title, MAX_FEEDBACK_TITLE],
  ["tried", FEEDBACK_STRINGS.labels.tried, MAX_FEEDBACK_FIELD],
  ["happened", FEEDBACK_STRINGS.labels.happened, MAX_FEEDBACK_FIELD],
  ["expected", FEEDBACK_STRINGS.labels.expected, MAX_FEEDBACK_FIELD],
] as const satisfies readonly (readonly [keyof FeedbackReport, string, number])[];

/** A report's type in the owner's words; a value outside the three shows as the team would get it. */
function feedbackKindText(kind: string): string {
  return Object.hasOwn(FEEDBACK_STRINGS.kinds, kind) ? FEEDBACK_STRINGS.kinds[kind] : plainText(kind, 40);
}

/**
 * One feedback report Main proposed: where it goes, its type and every field the TinyCloud team reads, what the team
 * sees of the sender, and Send report or Don't send. The area is always "other", so the card leaves it out. Send names
 * the binding the service gave with this card, so only this report can go.
 */
function FeedbackCard({ request, asks }: { request: ActionRequest; asks: Asks }) {
  const id = useId();
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, []);

  const { report, binding } = request;

  const submit = async (decision: Parameters<Asks["decide"]>[1]) => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    const result = await asks.decide(request, decision);
    setBusy(false);
    if (result === "failed") setFailed(true);
    if (result === "held") setHeld(true);
  };

  return (
    <section
      aria-labelledby={`${id}-title`}
      data-action-card=""
      data-feedback-card=""
      data-ask-id={request.id}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4"
    >
      <p id={`${id}-title`} className="text-headline">{FEEDBACK_STRINGS.title}</p>
      <p className="text-callout text-muted-foreground" data-feedback-destination="">{FEEDBACK_STRINGS.destination}</p>
      {report ? (
        <dl className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-callout text-muted-foreground">{FEEDBACK_STRINGS.labels.kind}</dt>
            <dd className="text-body" data-feedback-field="kind">{feedbackKindText(report.kind)}</dd>
          </div>
          {FEEDBACK_FIELDS.map(([field, label, max]) => (
            <div key={field} className="flex flex-col gap-0.5">
              <dt className="text-callout text-muted-foreground">{label}</dt>
              <dd className="whitespace-pre-wrap break-words text-body" data-feedback-field={field}>{plainLines(report[field], max)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="text-callout text-muted-foreground" data-feedback-sender="">{FEEDBACK_STRINGS.sender}</p>
      {report ? <p className="text-callout text-muted-foreground" data-feedback-agent="">{FEEDBACK_STRINGS.agent(plainText(report.agent, 100))}</p> : null}
      <p className="text-callout text-muted-foreground">{askedAgo(now - Date.parse(request.askedAt))}</p>
      {request.outside ? <p className="text-callout" data-action-outside="">{ACTION_STRINGS.outside}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy || held || !binding || !report} onClick={() => { if (binding) void submit({ decision: "approve", binding }); }}>{FEEDBACK_STRINGS.send}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={() => void submit({ decision: "decline" })}>{FEEDBACK_STRINGS.decline}</Button>
      </div>
      {failed ? <p role="alert" className="text-callout text-muted-foreground">{ACTION_STRINGS.sendFailed}</p> : null}
      {held ? <p role="alert" className="text-callout" data-action-held="">{FEEDBACK_STRINGS.refused}</p> : null}
    </section>
  );
}

/** What a proposal card collapses to, from the latest read of its request. */
function actionOutcomeText(request: ActionRequest): string | null {
  const nameOf = new Map(request.targets.map((target) => [target.key, plainText(target.name ?? "", 120) || ACTION_STRINGS.missing]));
  if (request.state === "sending") return ACTION_STRINGS.sending;
  if (request.state === "declined") return ACTION_STRINGS.declined;
  if (request.state === "expired") return ACTION_STRINGS.expired;
  if (request.state !== "done") return null;
  if (request.action === "send_feedback") return feedbackOutcomeText(request.feedback?.outcome ?? "unknown", request.feedback?.reportId);
  const outcomes = request.outcomes ?? [];
  const sent = outcomes.filter((outcome) => outcome.delivered).map((outcome) => nameOf.get(outcome.key) ?? ACTION_STRINGS.missing);
  const failed = outcomes.filter((outcome) => !outcome.delivered).map((outcome) => nameOf.get(outcome.key) ?? ACTION_STRINGS.missing);
  if (sent.length === 0) return ACTION_STRINGS.notSent;
  return failed.length === 0 ? ACTION_STRINGS.sent(joinNames(sent)) : ACTION_STRINGS.partly(joinNames(sent), joinNames(failed));
}

const APP_LINES = { answered: COPY.lineAnswered, declined: COPY.lineDeclined, stopped: COPY.lineStopped, expired: COPY.lineExpired } as const;

export type AppLineDecision = keyof typeof APP_LINES | "approved" | "revoked" | "ended";

/** A secret request's chat line, which names the secret; null when the line has nothing to name. */
function secretLineText(decision: AppLineDecision, secret: SecretLine): string | null {
  switch (decision) {
    case "approved": return secret.until ? SECRET_STRINGS.lineApproved(secret.name, secretWith(secret), secretDate(secret.until)) : null;
    case "revoked": return SECRET_STRINGS.lineRevoked(secret.name);
    case "declined": return SECRET_STRINGS.lineDeclined(secret.name);
    case "expired": return SECRET_STRINGS.lineExpired(secret.name);
    case "ended": return SECRET_STRINGS.lineEnded(secret.name);
    default: return null;
  }
}

/**
 * What the app shows in the chat for the owner's decision on a request or proposal card, in a muted style so it is not
 * taken for words the owner typed. A "not now" or decline the owner just gave is already on the card, which collapses
 * to it; once the card is gone (a reload), the line is what is left. An expired request, or a secret's access that
 * ended, has no message to Main: its line is only for the owner, and only for a request the owner saw in this chat. A
 * proposal's line names its recipients when this page knows them.
 */
export function AppLine({ decision, live, secret, names }: {
  decision: AppLineDecision | "action_approved" | "action_declined" | "feedback_sent" | "feedback_declined"; live: boolean; secret?: SecretLine; names?: readonly string[];
}) {
  if (decision === "feedback_sent" || decision === "feedback_declined") {
    const text = decision === "feedback_sent" ? FEEDBACK_STRINGS.lineSent : FEEDBACK_STRINGS.lineDeclined;
    return <p className="self-end text-callout text-muted-foreground" data-app-line={decision}>{text}</p>;
  }
  if (decision === "action_approved" || decision === "action_declined") {
    const recipients = names?.length ? joinNames(names.map((name) => plainText(name, 120) || ACTION_STRINGS.missing)) : ACTION_STRINGS.otherBots;
    const text = decision === "action_approved" ? ACTION_STRINGS.lineSent(recipients) : ACTION_STRINGS.lineDeclined(recipients);
    return <p className="self-end text-callout text-muted-foreground" data-app-line={decision}>{text}</p>;
  }
  if (decision === "declined" && live) return null;
  const text = secret ? secretLineText(decision, secret) : decision in APP_LINES ? APP_LINES[decision as keyof typeof APP_LINES] : null;
  if (!text) return null;
  return <p className="self-end text-callout text-muted-foreground" data-app-line={decision}>{text}</p>;
}

/**
 * The cards for Main's pending questions and proposals, one per request. `outcomes` is for Main's chat: what became
 * of a card the owner was looking at. Home leaves it out, so a resolved request there just goes away.
 */
export function AskCards({ asks, outcomes = false }: { asks: Asks; outcomes?: boolean }) {
  if (asks.support !== "yes") return null;
  return (
    <>
      {asks.stopped ? <p className="text-callout text-muted-foreground" data-ask-stopped="">{COPY.stopped}</p> : null}
      {asks.pending.map((request) => request.kind !== "action"
        ? <AskCard key={request.id} request={request} asks={asks} />
        : request.action === "send_feedback"
          ? <FeedbackCard key={request.id} request={request} asks={asks} />
          : <ActionCard key={request.id} request={request} asks={asks} />)}
      {outcomes
        ? asks.outcomes.map((outcome) => {
          if (outcome.kind === "action") {
            const text = actionOutcomeText(outcome.request);
            return text ? <p key={outcome.id} className="text-callout text-muted-foreground" data-action-outcome={outcome.request.state}>{text}</p> : null;
          }
          const { id, kind } = outcome;
          return kind === "declined" ? (
            <p key={id} className="text-callout text-muted-foreground" data-ask-outcome={kind}>{COPY.declined}</p>
          ) : (
            <Fragment key={id}>
              <p className="text-callout text-muted-foreground" data-ask-outcome={kind}>{COPY.expired}</p>
              <AppLine decision="expired" live />
            </Fragment>
          );
        })
        : null}
    </>
  );
}

/** Settings: Main's questions on or off. Nothing shows until the service says it has them. */
export function AsksToggle({ asks }: { asks: Asks }) {
  const id = useId();
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  if (asks.support !== "yes") return null;
  return (
    <div className="flex flex-col gap-1" data-bots-asks="">
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={asks.enabled}
          disabled={saving}
          aria-describedby={`${id}-help`}
          onChange={(event) => {
            const next = event.target.checked;
            setSaving(true);
            setFailed(false);
            void asks.setEnabled(next).then((result) => { setSaving(false); if (result === "failed") setFailed(true); });
          }}
          className="mt-1 size-4 shrink-0 accent-primary"
        />
        <span className="text-body">{COPY.toggleLabel}</span>
      </label>
      <p id={`${id}-help`} className="text-callout text-muted-foreground">{COPY.toggleHelp}</p>
      {failed ? <p role="alert" className="text-callout text-muted-foreground">{COPY.toggleFailed}</p> : null}
    </div>
  );
}
