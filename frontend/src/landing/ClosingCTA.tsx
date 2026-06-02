import { Link } from "react-router-dom";
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ClosingCTA() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-[-12rem] -z-10 h-[24rem] bg-gradient-to-t from-primary/10 via-primary/5 to-transparent blur-3xl"
      />
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-4 py-24 text-center sm:px-6 sm:py-28">
        <h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Your chats.{" "}
          <span className="text-primary">Your space.</span>
        </h2>
        <p className="max-w-xl text-balance text-muted-foreground">
          Sign in with Face ID or Touch ID and you're chatting in under a minute. Every
          conversation is saved to your own TinyCloud space — yours to keep,
          sync, or delete.
        </p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <Button size="lg" className="h-11 px-6" asChild>
            <Link to="/chat">
              Start chatting
              <ArrowRightIcon className="size-4" />
            </Link>
          </Button>
          <Button size="lg" variant="outline" className="h-11 px-6" asChild>
            <a href="#how-it-works">See how it works</a>
          </Button>
        </div>
      </div>
    </section>
  );
}
