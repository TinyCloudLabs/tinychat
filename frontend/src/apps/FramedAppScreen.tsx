// `/chat/apps/<appId>`: an app's screen inside One. Its bar (AppBar) on top; under it the app framed, running on a
// silent, scoped delegation of One's session, or, for an app One can't frame here, a calm page that opens it on its own.
// Lazy: loads only when the flag is on and an app route is open.

import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExternalLinkIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { openLinkInApp } from "@/feed/inAppLink";
import { appPinId } from "@/shell/navPins";
import { openKeyFailureOf } from "../lib/authErrors";
import { isNativeOpenKeySession } from "../lib/openkeyNative";
import { PlatformContext } from "../lib/platform";
import { useResolvedTheme } from "../lib/theme";
import { AppBar } from "./AppBar";
import { EmbedHost, type EmbedTheme } from "./embedHost";
import { frameGrantDelegate } from "./frameGrant";
import { RunnerHost } from "./runnerHost";
import { clampRequest, ownerSpaceId, resolveCeiling } from "./scope";
import { AppTileIcon, type GlyphId } from "./icons";
import { trackEmbed } from "./liveEmbeds";
import { appUrl, framedApp, framesAppHere, frameUrl, ONE_APPS, oneAppsFor, type FramedOneApp } from "./registry";
import { stepUpForApp, type StepUpConnect } from "./stepUp";
import {
  ASK_CLOSE,
  ASK_CONTINUE,
  ASK_NOT_NOW,
  askBody,
  askNotInApp,
  askTitle,
  COURIER_MISSING,
  courierMissing,
  joinScopes,
  missingSpacesLine,
  OPEN_IN_ONE,
  openSeparately,
  opensInOneTitle,
  opensSeparatelyTitle,
  stepUpFailedLine,
  type ScopeId,
  runFailedLine,
} from "./strings";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

interface Ask {
  scopes: ScopeId[];
  /** Space names known not to be set up, named under the body. */
  missing: string[];
  answer(proceed: boolean): void;
}

/** Spaces the app asked for that aren't set up. `none`: nothing it asked for exists (Close only). */
interface Missing {
  spaces: string[];
  none: boolean;
}

/** Courier's own page, where "Open Courier" leads (a new tab, never the framed route). */
function courierPage(): string | undefined {
  const courier = ONE_APPS.find((entry) => entry.id === "xyz.tinycloud.courier");
  return courier && "origin" in courier ? `${courier.origin}${courier.path}` : undefined;
}

export interface FramedAppScreenProps {
  appId: string;
  tcw: TinyCloudWeb | null;
  /** Shown instead for an id with no screen here (unknown, or One's own Recording), and for a framed app with no session. */
  fallback: ReactNode;
  /** OpenKey connect for the step-up; One uses the real one. The dev harness (apps/dev) passes a local key. */
  connect?: StepUpConnect;
}

export function FramedAppScreen({ appId, tcw, fallback, connect }: FramedAppScreenProps) {
  const app = framedApp(appId);
  const session = tcw?.session();
  if (!app || !tcw || !session || !framesAppHere(app, window.location.origin)) return <>{fallback}</>;
  return <FramedApp key={`${app.id}:${session.address}:${session.chainId}:${session.sessionKey}`} app={app} tcw={tcw} address={session.address} chainId={session.chainId} connect={connect} />;
}

export interface OneAppScreenProps extends FramedAppScreenProps {
  /** The signed-in account, whose pins the bar's Pin changes; null hides Pin. */
  accountDid?: string | null;
}

/**
 * One's new navigation (ONE_NAV_ENABLED): every web app's screen in One, the open app's bar on top of the framed app,
 * or, where One can't frame it, of a screen that opens it on its own. Only `framedApp` (the frame allowlist and its
 * ceilings) decides what is framed; an app the new navigation lists that it doesn't know opens on its own.
 */
export function OneAppScreen({ appId, tcw, accountDid = null, fallback, connect }: OneAppScreenProps) {
  const platform = useContext(PlatformContext);
  // Every app the new navigation lists, whatever this build's flag (Share is listed only with it).
  const app = oneAppsFor(platform, true).find((entry) => entry.id === appId);
  if (!app || app.kind === "native") return <>{fallback}</>;
  const frameable = framedApp(app.id);
  const framed = frameable && framesAppHere(frameable, window.location.origin) ? frameable : undefined;
  const session = tcw?.session();
  if (framed && (!tcw || !session)) return <>{fallback}</>;
  const url = appUrl(app);
  // An app kept in the owner's space, framed here: its page is this screen, so the bar offers no new tab.
  const barUrl = framed?.fromSpace ? undefined : url;
  const inOne = app.kind === "framed" && app.fromSpace === true;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="one-app-screen">
      <AppBar name={app.name} glyph={app.glyph} accountDid={accountDid} pin={appPinId(app.id)} url={barUrl} />
      {framed && tcw && session ? (
        <FramedApp key={`${framed.id}:${session.address}:${session.chainId}:${session.sessionKey}`} app={framed} tcw={tcw} address={session.address} chainId={session.chainId} connect={connect} />
      ) : (
        <OpensSeparately name={app.name} glyph={app.glyph} url={url} phone={platform === "ios" || platform === "android"} inOne={inOne} />
      )}
    </div>
  );
}

/**
 * An app One can't frame here (it is never framed, or not on this origin or platform): it opens on its own. An app kept
 * in the owner's space (`inOne`) has no page of its own: it offers its screen in One on the web.
 */
function OpensSeparately({ name, glyph, url, phone, inOne }: { name: string; glyph: GlyphId; url: string; phone: boolean; inOne: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <AppTileIcon id={glyph} className="mb-2 size-16" />
        <h2 className="text-title-2 text-foreground">{inOne ? opensInOneTitle(name) : opensSeparatelyTitle(name, phone)}</h2>
        <Button asChild className="mt-2">
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => openLinkInApp(url, event.nativeEvent, { sheet: false })}>
            {inOne ? OPEN_IN_ONE : openSeparately(name, phone)}
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
      </div>
    </div>
  );
}

interface FramedAppProps {
  app: FramedOneApp;
  tcw: TinyCloudWeb;
  address: string;
  chainId: number;
  connect?: StepUpConnect;
}

// Keyed by app, owner and session key: a different app or One session is a fresh frame, host and grant.
function FramedApp({ app, tcw, address, chainId, connect }: FramedAppProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useResolvedTheme();
  const themeRef = useRef<EmbedTheme>(theme);
  themeRef.current = theme;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [failedLine, setFailedLine] = useState<string | null>(null);
  const [missing, setMissing] = useState<Missing | null>(null);
  const src = useMemo(() => frameUrl(app), [app]);
  const hostRef = useRef<EmbedHost | null>(null);

  // One host per mount: its close ends the frame's grant for good, so a remount (StrictMode included) starts a fresh one.
  useEffect(() => {
    const host = new EmbedHost({
      app,
      owner: { address, chainId },
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, app.origin),
      holds: (entries) => tcw.hasPermissions(entries),
      delegate: frameGrantDelegate(tcw),
      stepUp: (scopes, entries, missingSpaces) => askThenStepUp(scopes, entries, missingSpaces),
      missing: (spaces, none) => {
        setFailedLine(null);
        setMissing({ spaces, none });
      },
      theme: () => themeRef.current,
      onError: (error) => console.warn("[One Apps] embed message failed", app.id, error),
    });
    hostRef.current = host;
    // An app kept in the owner's space: the runner page at its sub-address asks for its files first (runnerHost.ts).
    const owner = { address, chainId };
    const appsKv = app.fromSpace ? tcw.kvForSpace(ownerSpaceId(owner, "applications")) : null;
    const runner = app.fromSpace ? new RunnerHost({
      app,
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      post: (message, transfer) => frameRef.current?.contentWindow?.postMessage(message, app.origin, transfer),
      canRead: () => {
        const files: PermissionEntry = { service: "tinycloud.kv", space: ownerSpaceId(owner, "applications"), path: `${app.id}/app/`, actions: ["get"] };
        if (tcw.hasPermissions([files])) return Promise.resolve(true);
        // Ask with the app's own entry that covers its files, so its hello then gets that space with no second ask.
        const covering = clampRequest(owner, resolveCeiling(owner, app.ceiling(owner)), [files]);
        return covering
          ? askThenStepUp([...new Set(covering.map((entry) => entry.scope))], covering.map((entry) => entry.permission), [])
          : askThenStepUp(["appsData"], [files], []);
      },
      read: async (key) => {
        const result = await appsKv!.get(key, { binary: true, source: "network" });
        if (!result.ok) throw new Error(`one_run_read_failed:${result.error.code}`);
        return result.data.data as Uint8Array;
      },
      failed: (reason) => {
        setMissing(null);
        setFailedLine(runFailedLine(app.name, reason));
      },
      onError: (error) => console.warn("[One Apps] runner message failed", app.id, error),
    }) : null;
    const onMessage = (event: MessageEvent) => {
      void host.handle(event);
      if (runner) void runner.handle(event);
    };
    window.addEventListener("message", onMessage);
    const untrack = trackEmbed(() => host.close());
    return () => {
      window.removeEventListener("message", onMessage);
      untrack();
      runner?.close();
      if (hostRef.current === host) hostRef.current = null;
      void host.close();
    };
    // askThenStepUp only uses state setters and these same props.
  }, [app, address, chainId, tcw]);

  useEffect(() => { hostRef.current?.setTheme(theme); }, [theme]);

  function askThenStepUp(scopes: ScopeId[], entries: PermissionEntry[], missingSpaces: string[]): Promise<boolean> {
    // The phone app's session never signs (OpenKey's canonical key stays out of the app): no OpenKey step-up there.
    if (isNativeOpenKeySession()) {
      setMissing(null);
      setFailedLine(askNotInApp(app.name));
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      let settled = false;
      setFailedLine(null);
      setMissing(null);
      setAsk({ scopes, missing: missingSpaces, answer: (proceed) => {
        if (settled) return;
        settled = true;
        setAsk(null);
        if (!proceed) {
          setFailedLine(stepUpFailedLine(app.name, { kind: "declined" }));
          resolve(false);
          return;
        }
        stepUpForApp(tcw, entries, connect).then((approved) => {
          if (!approved) setFailedLine(stepUpFailedLine(app.name, { kind: "declined" }));
          resolve(approved);
        }, (error: unknown) => {
          console.warn("[One Apps] step-up failed", app.id, error);
          const ownerChanged = error instanceof Error && error.message === "one_apps_owner_changed";
          setFailedLine(stepUpFailedLine(app.name, ownerChanged ? { kind: "wrong-account" } : openKeyFailureOf(error)));
          resolve(false);
        });
      } });
    });
  }

  const missingLine = missing ? missingSpacesLine(app.name, missing.spaces, missing.none) : undefined;
  const courierLine = missing !== null && courierMissing(missing.spaces);
  const askMissingLine = ask ? missingSpacesLine(app.name, ask.missing, false) : undefined;
  const courierHref = courierPage();
  const courierText = (
    <>
      {COURIER_MISSING.before}
      <a href={courierHref} target="_blank" rel="noopener noreferrer" className="underline">{COURIER_MISSING.link}</a>
      {COURIER_MISSING.after}
    </>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col [html[data-pill]_&]:pb-[var(--tc-bottom-chrome)]" data-testid="one-app-frame">
      {failedLine && (
        <p role="status" className="border-b border-border bg-muted px-4 py-2 text-sm">{failedLine}</p>
      )}
      {missing && !missing.none && (missingLine || courierLine) && (
        <div role="status" className="border-b border-border bg-muted px-4 py-2 text-sm">
          {missingLine && <p>{missingLine}</p>}
          {courierLine && <p>{courierText}</p>}
        </div>
      )}
      <iframe
        ref={frameRef}
        src={src}
        title={app.name}
        sandbox={SANDBOX}
        allow="clipboard-write"
        referrerPolicy="strict-origin"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
      <AlertDialog open={ask !== null} onOpenChange={(open) => { if (!open) ask?.answer(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{askTitle(app.name)}</AlertDialogTitle>
            <AlertDialogDescription>{askBody(app.name, joinScopes(ask?.scopes ?? []))}</AlertDialogDescription>
            {askMissingLine && <p className="text-sm text-muted-foreground">{askMissingLine}</p>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => ask?.answer(false)}>{ASK_NOT_NOW}</AlertDialogCancel>
            <AlertDialogAction onClick={() => ask?.answer(true)}>{ASK_CONTINUE}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={missing !== null && missing.none && Boolean(missingLine || courierLine)} onOpenChange={(open) => { if (!open) setMissing(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{askTitle(app.name)}</AlertDialogTitle>
            {courierLine ? (
              <AlertDialogDescription>{courierText}</AlertDialogDescription>
            ) : (
              <AlertDialogDescription>{missingLine}</AlertDialogDescription>
            )}
            {courierLine && missingLine && <p className="text-sm text-muted-foreground">{missingLine}</p>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setMissing(null)}>{ASK_CLOSE}</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
