// The Home site's signed-out demo (TC-2387): three sample cards a visitor can
// answer. They render with the signed-in Home card (FeedCardView and the shared
// card parts), so the two can't drift. Plain component state: nothing is read
// from or written to any space or server, and reloading resets it.
import { useState } from "react";

import { FeedCardView } from "@/feed/FeedView";
import { AnsweredPanel, chipClass, OptionButtons, QuietRow, quietClass } from "@/feed/cardKit";

type DemoCard =
  | { id: string; kind: "ask"; agent: string; ago: number; title: string; body: string; options: { id: string; label: string; detail: string }[]; recommend: string; done: string }
  | { id: string; kind: "task"; agent: string; ago: number; title: string; body: string; steps: string[] }
  | { id: string; kind: "update"; agent: string; ago: number; title: string; body: string };

const MINUTE = 60_000;
const CARDS: DemoCard[] = [
  { id: "flight", kind: "ask", agent: "Travel agent", ago: 2 * MINUTE, title: "Which flight should I hold for Thursday?",
    body: "Two flights fit your calendar. Holding one is free for 24 hours.",
    options: [{ id: "early", label: "07:10 direct", detail: "Arrives 09:05" }, { id: "later", label: "09:40, one stop", detail: "Arrives 13:20, costs less" }],
    recommend: "early", done: "Travel agent will hold it and remind you tomorrow." },
  { id: "reading", kind: "task", agent: "Research agent", ago: 40 * MINUTE, title: "This week's reading list",
    body: "Five papers matched your topics. Two are short.", steps: ["Skim the two short papers", "Pick one to discuss in Chat"] },
  { id: "backup", kind: "update", agent: "Home agent", ago: 3 * 60 * MINUTE, title: "Photo backup finished",
    body: "1,204 new photos are stored in your TinyCloud space." },
];

export function HomeDemoFeed() {
  const [now] = useState(() => Date.now());
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [changing, setChanging] = useState<Record<string, boolean>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  return (
    <ul aria-label="Demo feed" className="grid min-w-0 gap-3">
      {CARDS.map((card) => {
        const answer = card.kind === "ask" && !changing[card.id] ? answers[card.id] : undefined;
        const chip = card.kind === "ask" ? <span className={chipClass}>{answer ? "Answered" : "Needs you"}</span> : undefined;
        return (
          <li key={card.id}>
            <FeedCardView sample={false} heading="h3" now={now} chip={chip}
              card={{ key: card.id, at: new Date(now - card.ago).toISOString(), author: { name: card.agent }, render: "post", title: card.title, lead: { text: card.body } }}>
              {card.kind === "ask" && (answer
                ? <>
                    <AnsweredPanel focusOnMount><p>You chose <b className="font-semibold">{card.options.find((option) => option.id === answer)?.label}</b>. {card.done}</p></AnsweredPanel>
                    <QuietRow><button type="button" className={quietClass} onClick={() => setChanging((previous) => ({ ...previous, [card.id]: true }))}>Change answer</button></QuietRow>
                  </>
                : <OptionButtons options={card.options} suggested={card.recommend} onChoose={(id) => {
                    setAnswers((previous) => ({ ...previous, [card.id]: id }));
                    setChanging((previous) => ({ ...previous, [card.id]: false }));
                  }} />)}
              {card.kind === "task" && <ul className="mt-3.5 grid">
                {card.steps.map((step) => {
                  const key = `${card.id}:${step}`;
                  return <li key={key}><label className="flex min-h-11 cursor-pointer items-center gap-3 text-[15px]">
                    <input type="checkbox" className="size-5 accent-foreground" checked={!!checked[key]} onChange={(event) => setChecked((previous) => ({ ...previous, [key]: event.target.checked }))} />
                    <span className={checked[key] ? "text-muted-foreground line-through" : ""}>{step}</span>
                  </label></li>;
                })}
              </ul>}
            </FeedCardView>
          </li>
        );
      })}
    </ul>
  );
}
