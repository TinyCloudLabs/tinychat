import { Link } from "react-router-dom";
import { ThemeToggle } from "@/components/theme-toggle";

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col items-start justify-between gap-8 sm:flex-row sm:items-center">
          <div className="flex flex-col gap-3">
            <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">
                T
              </span>
              TinyCloud Chat
            </Link>
            <p className="max-w-sm text-xs text-muted-foreground">
              A private, multi-model chat client. Your conversations live in
              your space — not ours.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
            <a href="#features" className="transition-colors hover:text-foreground">
              Features
            </a>
            <a href="#how-it-works" className="transition-colors hover:text-foreground">
              How it works
            </a>
            <Link to="/chat" className="transition-colors hover:text-foreground">
              Open app
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <div className="mt-10 flex flex-col items-start justify-between gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <span>© TinyCloud Chat</span>
          <span>Built on TinyCloud</span>
        </div>
      </div>
    </footer>
  );
}
