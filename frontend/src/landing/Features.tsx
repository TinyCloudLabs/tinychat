import {
  MessageCircleIcon,
  ArrowLeftRightIcon,
  PenLineIcon,
  DatabaseIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Feature {
  icon: LucideIcon;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: MessageCircleIcon,
    title: "Ask",
    body: "Questions, brainstorming, decisions, and research — answered fast with streaming responses.",
  },
  {
    icon: ArrowLeftRightIcon,
    title: "Switch",
    body: "Pick from a range of models and swap mid-thread. The conversation keeps its full context across model switches.",
  },
  {
    icon: PenLineIcon,
    title: "Write",
    body: "Draft, edit, and refactor with clean markdown rendering and syntax-highlighted code blocks.",
  },
  {
    icon: DatabaseIcon,
    title: "Remember",
    body: "Every thread is saved to your own per-space database and synced across devices. Your history stays yours and stays portable.",
  },
];

export function Features() {
  return (
    <section id="features" className="border-b border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary/80">
            What you can do
          </p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            One chat client.{" "}
            <span className="text-primary">The parts you use, done well.</span>
          </h2>
          <p className="mt-4 text-muted-foreground">
            Built on TinyCloud — your identity, your storage, your choice of
            model. No account silo, no lock-in.
          </p>
        </div>

        <div className="mt-14 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div
              key={title}
              className="group flex flex-col gap-3 bg-card p-6 transition-colors hover:bg-accent/40"
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Icon className="size-4.5" />
              </span>
              <h3 className="text-base font-semibold">{title}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
