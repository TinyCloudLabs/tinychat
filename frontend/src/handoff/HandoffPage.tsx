import { useEffect, useState } from "react";
import { ArrowRight, Check, Copy, Link2, LockKeyhole, Smartphone } from "lucide-react";
import { Link, Navigate } from "react-router-dom";

import { AppTileIcon } from "@/apps/icons";
import { APP_NAMES } from "@/apps/strings";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { APP_NAME } from "@/lib/homeSite";

import { openHandoff, type HandoffView } from "./readHandoff";
import { handoffStrings as copy } from "./strings";

const buttonSize = "h-auto min-h-11 whitespace-normal";
const sectionHeading = "font-display text-xl font-semibold leading-tight";
const pageWidth = "mx-auto w-full max-w-[70rem] px-4 sm:px-8";
const desktopColumns = "grid gap-8 lg:grid-cols-[minmax(0,1.13fr)_minmax(0,1fr)] lg:gap-16";
const relativeTime = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function connectionTime(time: number, now: number): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return copy.justNow;
  if (minutes < 60) return copy.connectedAt(relativeTime.format(-minutes, "minute"));
  const hours = Math.floor(minutes / 60);
  return copy.connectedAt(hours < 24 ? relativeTime.format(-hours, "hour") : relativeTime.format(-Math.floor(hours / 24), "day"));
}

function Connection({ view, now }: { view: HandoffView; now: number }) {
  return (
    <section aria-labelledby="handoff-agent" className="overflow-hidden rounded-xl border bg-card">
      <div className="p-4">
        <div className="flex flex-wrap items-start gap-3">
          <AppTileIcon id="credentials" className="size-11 shrink-0" />
          <div className="min-w-0 flex-1 basis-40">
            <h2 id="handoff-agent" className="text-lg font-semibold">{copy.connected(view.agentName)}</h2>
            <div className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
              <span>{copy.machine(view.machineLabel)}</span>
              <span className="inline-flex items-center gap-1.5">
                <Check aria-hidden className="size-4 shrink-0" />{connectionTime(view.connectedAt, now)}
              </span>
            </div>
          </div>
        </div>
        <h3 className="mt-3 text-sm font-semibold">{copy.abilitiesHeading}</h3>
        <ul className="ml-4 list-disc text-sm">
          {view.abilities.map((ability) => <li key={ability}>{copy.abilities[ability]}</li>)}
        </ul>
        <p className="mt-3 text-sm text-muted-foreground">
          {copy.until(new Date(view.accessExpiresAt).toLocaleDateString(undefined, { dateStyle: "long" }))}
        </p>
      </div>
      <div className="flex items-start gap-2.5 border-t bg-chrome p-4 text-sm">
        <LockKeyhole aria-hidden className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-semibold">
            {copy.linkExpiry(new Date(view.linkExpiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}
          </p>
          <p>{copy.privacy}</p>
        </div>
      </div>
    </section>
  );
}

function PromptRow({ item }: { item: (typeof copy.prompts)[number] }) {
  const [status, setStatus] = useState<"idle" | "copied" | "manual">("idle");

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(item.prompt);
      setStatus("copied");
    } catch {
      setStatus("manual");
    }
  }

  return (
    <li className="border-b py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <AppTileIcon id={item.icon} className="size-9 shrink-0" />
        <div className="min-w-0 flex-1 basis-40">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="text-sm text-muted-foreground">{item.body}</p>
        </div>
        <Button type="button" variant="outline" className={buttonSize} aria-label={`${copy.copy} · ${item.title}`} onClick={() => { void copyPrompt(); }}>
          <Copy aria-hidden />{copy.copy}
        </Button>
      </div>
      <div role="status" className="text-sm">
        {status === "copied" && <p className="mt-2">{copy.copied}</p>}
        {status === "manual" && <p className="mt-2 select-text">{copy.copyManually}. {item.prompt}</p>}
      </div>
    </li>
  );
}

function Coming() {
  const [interested, setInterested] = useState(false);
  return (
    <section aria-labelledby="handoff-coming" className="border-t pt-4">
      <p className="text-sm text-muted-foreground">{copy.coming}</p>
      <h2 id="handoff-coming" className={sectionHeading}>{copy.comingTitle}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{copy.comingBody}</p>
      <Button type="button" variant="outline" className={`mt-3 ${buttonSize}`} aria-pressed={interested} onClick={() => setInterested(true)}>
        {copy.tellMe}
      </Button>
      <div role="status" className="text-sm">{interested && <p className="mt-2">{copy.tellMeSelected}</p>}</div>
    </section>
  );
}

function PhoneInstall() {
  const [platform, setPlatform] = useState<"iphone" | "android" | null>(null);
  return (
    <section aria-labelledby="handoff-phone" className="p-4 sm:p-5">
      <h2 id="handoff-phone" className={sectionHeading}>{copy.mobile}</h2>
      <p className="mt-1 text-sm">{copy.mobileBody}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="outline" className={`bg-background ${buttonSize}`} aria-expanded={platform === "iphone"} aria-controls="handoff-install-help" onClick={() => setPlatform(platform === "iphone" ? null : "iphone")}>
          <Smartphone aria-hidden />{copy.installIphone}
        </Button>
        <Button type="button" variant="outline" className={`bg-background ${buttonSize}`} aria-expanded={platform === "android"} aria-controls="handoff-install-help" onClick={() => setPlatform(platform === "android" ? null : "android")}>
          <Smartphone aria-hidden />{copy.installAndroid}
        </Button>
      </div>
      <div id="handoff-install-help" role="status" className="text-sm">
        {platform && <p className="mt-3">{platform === "iphone" ? copy.iphoneHelp : copy.androidHelp}</p>}
      </div>
    </section>
  );
}

function HandoffContent({ view, now }: { view: HandoffView; now: number }) {
  return (
    <main className={`${pageWidth} space-y-6 pb-8 pt-5 sm:space-y-8 sm:pt-6`}>
      <div className={`${desktopColumns} items-center`}>
        <div>
          <h1 className="font-display text-5xl font-semibold leading-tight sm:text-6xl">{copy.title}</h1>
          <p className="mt-2 max-w-lg text-lg text-muted-foreground">{copy.intro}</p>
          <p className="mt-4 flex items-start gap-2 text-sm text-muted-foreground">
            <Link2 aria-hidden className="mt-0.5 size-4 shrink-0" />{copy.byline}
          </p>
        </div>
        <Connection view={view} now={now} />
      </div>
      <div className={`${desktopColumns} border-t pt-5`}>
        <section aria-labelledby="handoff-prompts">
          <h2 id="handoff-prompts" className={sectionHeading}>{copy.tryThese}</h2>
          {view.setupChoicePath && <Button asChild className={`mt-3 ${buttonSize}`}>
            <Link to={view.setupChoicePath}>{copy.openSetupChoice}<ArrowRight aria-hidden /></Link>
          </Button>}
          <p className="mt-1 text-muted-foreground">{copy.promptIntro}</p>
          <ul className="mt-3 border-t">
            {copy.prompts.map((item) => <PromptRow key={item.icon} item={item} />)}
          </ul>
        </section>
        <div className="space-y-5">
          <section aria-labelledby="handoff-apps">
            <h2 id="handoff-apps" className={sectionHeading}>{copy.apps}</h2>
            {view.appIds.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {view.appIds.map((id) => (
                  <li key={id} className="min-w-0 break-all rounded-md border px-2.5 py-1 text-sm">
                    {Object.hasOwn(APP_NAMES, id) ? APP_NAMES[id as keyof typeof APP_NAMES] : id}
                  </li>
                ))}
              </ul>
            ) : <p className="mt-2 text-sm text-muted-foreground">{copy.noApps}</p>}
            {view.appsTruncated && <p className="mt-2 text-sm text-muted-foreground">{copy.moreApps}</p>}
          </section>
          <Coming />
        </div>
      </div>
      <div className="grid divide-y rounded-xl border bg-chrome lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <PhoneInstall />
        <section aria-labelledby="handoff-sign-in" className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
          <div className="min-w-0 flex-1 basis-56">
            <h2 id="handoff-sign-in" className={sectionHeading}>{copy.signInTitle}</h2>
            <p className="mt-1 text-sm">{copy.signInBody}</p>
          </div>
          <Button asChild className={buttonSize}>
            <Link to="/" replace>{copy.signIn}<ArrowRight aria-hidden /></Link>
          </Button>
        </section>
      </div>
    </main>
  );
}

// One read per navigation, including StrictMode's repeated effect. The boot
// callback drops the credential when called. This promise retains only the view.
let opening: Promise<HandoffView | null> | undefined;

export default function HandoffPage() {
  const [view, setView] = useState<HandoffView | null>();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    opening ??= openHandoff(window.takeHandoffFragment?.());
    let active = true;
    void opening.then((result) => {
      if (!active) return;
      setNow(Date.now());
      setView(result);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!view) return;
    const now = Date.now();
    const elapsed = Math.max(0, now - view.connectedAt);
    const updateAt = Math.min(view.linkExpiresAt, now + 60_000 - elapsed % 60_000);
    const timer = window.setTimeout(() => {
      // Also discard the view when this document is kept alive past expiry.
      if (Date.now() >= view.linkExpiresAt) {
        opening = undefined;
        setView(null);
      } else {
        setNow(Date.now());
      }
    }, Math.max(0, updateAt - now));
    return () => window.clearTimeout(timer);
  }, [view, now]);

  if (view === null || (view && now >= view.linkExpiresAt)) return <Navigate to="/" replace />;

  return (
    <>
      <header className="border-b bg-chrome">
        <div className={`${pageWidth} flex min-h-14 items-center justify-between gap-3 py-2`}>
          <div className="flex min-w-0 items-center gap-2.5 font-display font-semibold">
            <img src="/icons/pwa-192.png" alt="" className="size-8 shrink-0 rounded-lg" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{APP_NAME}</span>
          </div>
          <div className="shrink-0 [&_button]:size-11"><ThemeToggle /></div>
        </div>
      </header>
      {view ? <HandoffContent view={view} now={now} /> : <main className={`${pageWidth} pt-6`}><p role="status">{copy.loading}</p></main>}
    </>
  );
}
