import { Link } from "react-router-dom";
import {
  ArrowRightIcon,
  CpuIcon,
  RefreshCwIcon,
  ScanFaceIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="relative overflow-hidden border-b border-border">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[-10rem] -z-10 h-[28rem] bg-gradient-to-b from-primary/10 via-primary/5 to-transparent blur-3xl"
      />
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-8 px-4 py-24 text-center sm:px-6 sm:py-32">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-green-500" />
          Private by design — your space, your data
        </span>

        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          A chatbot that keeps your chats{" "}
          <span className="text-primary underline decoration-primary/30 decoration-4 underline-offset-8">
            yours.
          </span>
        </h1>

        <p className="max-w-2xl text-balance text-base text-muted-foreground sm:text-lg">
          TinyCloud Chat is a fast, multi-model assistant where every
          conversation is saved to{" "}
          <span className="text-foreground">your own TinyCloud space</span> —
          yours to keep, synced across your devices, and{" "}
          <span className="text-foreground">never trapped in a provider's account</span>.
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

        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <ScanFaceIcon className="size-3.5" />
            Face ID / Touch ID
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ShieldCheckIcon className="size-3.5" />
            Stored in your own space
          </span>
          <span className="inline-flex items-center gap-1.5">
            <RefreshCwIcon className="size-3.5" />
            Synced across devices
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CpuIcon className="size-3.5" />
            Runs in secure enclaves
          </span>
        </div>
      </div>
    </section>
  );
}
