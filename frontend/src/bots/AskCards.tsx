// Main's questions as cards. The question and choices come from the box, so they are only ever rendered as text
// children: no markup, links or images, and hidden or direction-changing characters are removed first (askText.ts).
import { Fragment, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { AskRequest, SecretLine } from "./botsApi";
import { ASK_STRINGS as COPY, SECRET_STRINGS, askedAgo, secretDate, secretWith } from "./askStrings";
import { MAX_ANSWER, MAX_CHOICE, MAX_CHOICES, MAX_QUESTION, plainText } from "./askText";
import type { Asks } from "./useAsks";

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
 * What the app shows in the chat for the owner's decision on a request card, in a muted style so it is not taken for
 * words the owner typed. A "not now" or decline the owner just gave is already on the card, which collapses to it; once
 * the card is gone (a reload), the line is what is left. An expired request, or a secret's access that ended, has no
 * message to Main: its line is only for the owner, and only for a request the owner saw in this chat.
 */
export function AppLine({ decision, live, secret }: { decision: AppLineDecision; live: boolean; secret?: SecretLine }) {
  if (decision === "declined" && live) return null;
  const text = secret ? secretLineText(decision, secret) : decision in APP_LINES ? APP_LINES[decision as keyof typeof APP_LINES] : null;
  if (!text) return null;
  return <p className="self-end text-callout text-muted-foreground" data-app-line={decision}>{text}</p>;
}

/**
 * The cards for Main's pending questions, one per request. `outcomes` is for Main's chat: what became of a card the
 * owner was looking at. Home leaves it out, so a resolved question there just goes away.
 */
export function AskCards({ asks, outcomes = false }: { asks: Asks; outcomes?: boolean }) {
  if (asks.support !== "yes") return null;
  return (
    <>
      {asks.stopped ? <p className="text-callout text-muted-foreground" data-ask-stopped="">{COPY.stopped}</p> : null}
      {asks.pending.map((request) => <AskCard key={request.id} request={request} asks={asks} />)}
      {outcomes
        ? asks.outcomes.map(({ id, kind }) => kind === "declined" ? (
          <p key={id} className="text-callout text-muted-foreground" data-ask-outcome={kind}>{COPY.declined}</p>
        ) : (
          <Fragment key={id}>
            <p className="text-callout text-muted-foreground" data-ask-outcome={kind}>{COPY.expired}</p>
            <AppLine decision="expired" live />
          </Fragment>
        ))
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
