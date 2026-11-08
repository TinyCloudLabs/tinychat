// The Home site's signed-out demo (TC-2387): three sample cards a visitor can
// answer. Plain component state: nothing is read from or written to any space
// or server, and reloading resets it.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckIcon } from "lucide-react";

type DemoCard =
  | { id: string; kind: "ask"; agent: string; when: string; title: string; body: string; options: { id: string; label: string; detail: string }[]; recommend: string; done: string }
  | { id: string; kind: "task"; agent: string; when: string; title: string; body: string; steps: string[] }
  | { id: string; kind: "update"; agent: string; when: string; title: string; body: string };

const CARDS: DemoCard[] = [
  { id: "flight", kind: "ask", agent: "Travel agent", when: "2 min ago", title: "Which flight should I hold for Thursday?",
    body: "Two flights fit your calendar. Holding one is free for 24 hours.",
    options: [{ id: "early", label: "07:10 direct", detail: "Arrives 09:05" }, { id: "later", label: "09:40, one stop", detail: "Arrives 13:20, costs less" }],
    recommend: "early", done: "Travel agent will hold it and remind you tomorrow." },
  { id: "reading", kind: "task", agent: "Research agent", when: "1 hour ago", title: "This week's reading list",
    body: "Five papers matched your topics. Two are short.", steps: ["Skim the two short papers", "Pick one to discuss in Chat"] },
  { id: "backup", kind: "update", agent: "Home agent", when: "Today, 09:00", title: "Photo backup finished",
    body: "1,204 new photos are stored in your TinyCloud space." },
];

const chip = "shrink-0 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground";

/** The answered line; it takes focus when it appears, so the answer is announced where the options were. */
function AnsweredStatus({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return <p ref={ref} role="status" tabIndex={-1} className="mt-4 flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{children}</p>;
}

export function HomeDemoFeed() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return (
    <ul aria-label="Demo feed" className="grid min-w-0 gap-4">
      {CARDS.map((card) => {
        const answer = answers[card.id];
        return (
          <li key={card.id}>
            <article aria-label={card.title} className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-sm sm:p-5">
              <div className="flex items-center gap-2 text-sm">
                <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">{card.agent[0]}</span>
                <span className="min-w-0 truncate"><span className="font-medium">{card.agent}</span><span className="text-muted-foreground"> · {card.when}</span></span>
                <span className={`ml-auto ${chip}`}>{card.kind === "update" ? "Update" : answer ? "Answered" : "Needs you"}</span>
              </div>
              <h3 className="mt-3 font-display text-lg font-semibold leading-snug">{card.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{card.body}</p>
              {card.kind === "ask" && (answer
                ? <AnsweredStatus>
                    <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                    <span>You chose {card.options.find((option) => option.id === answer)?.label}. {card.done}</span>
                  </AnsweredStatus>
                : <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {card.options.map((option) => (
                      <button key={option.id} type="button" onClick={() => setAnswers((previous) => ({ ...previous, [card.id]: option.id }))}
                        className="min-h-12 rounded-xl border border-border px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="flex items-center gap-2 font-medium">{option.label}{option.id === card.recommend && <span className={chip}>Suggested</span>}</span>
                        <span className="block text-muted-foreground">{option.detail}</span>
                      </button>
                    ))}
                  </div>)}
              {card.kind === "task" && <ul className="mt-4 grid gap-1">
                {card.steps.map((step) => {
                  const key = `${card.id}:${step}`;
                  return <li key={key}><label className="flex min-h-10 cursor-pointer items-center gap-3 text-sm">
                    <input type="checkbox" className="size-4" checked={!!checked[key]} onChange={(event) => setChecked((previous) => ({ ...previous, [key]: event.target.checked }))} />
                    <span className={checked[key] ? "text-muted-foreground line-through" : ""}>{step}</span>
                  </label></li>;
                })}
              </ul>}
            </article>
          </li>
        );
      })}
    </ul>
  );
}
