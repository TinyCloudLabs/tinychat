// `/chat/apps/<appId>`: an app's screen inside One. Its bar (AppBar) on top; under it the app framed, running on a
// silent, scoped delegation of One's session, or, for an app One can't frame here, a calm page that opens it on its own.
// Lazy: loads only when the flag is on and an app route is open.

import { serializeDelegation, type PermissionEntry, type TinyCloudWeb } from "@tinycloud/web-sdk";
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
import { EmbedHost, SpaceNotHostedError, type EmbedTheme } from "./embedHost";
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
  openSeparately,
  opensSeparatelyLine,
  opensSeparatelyTitle,
  stepUpFailedLine,
  type ScopeId,
} from "./strings";

const GRANT_LIFETIME_MS = 60 * 60 * 1000;
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

/** True when the node skipped the delegation's space: it answered 200 but does not host it (requireActivation). */
function skippedByNode(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { success?: unknown; skipped?: unknown } | undefined) : undefined;
  return cause?.success === true && Array.isArray(cause.skipped) && cause.skipped.length > 0;
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
 * or, where One can't frame it, of a screen that opens it on its own.
 */
export function OneAppScreen({ appId, tcw, accountDid = null, fallback, connect }: OneAppScreenProps) {
  const platform = useContext(PlatformContext);
  // Every app the new navigation lists, whatever this build's flag (Share is listed only with it).
  const app = oneAppsFor(platform, true).find((entry) => entry.id === appId);
  if (!app || app.kind === "native") return <>{fallback}</>;
  const frameable = app.kind === "framed" && app.framed ? app : undefined;
  const framed = frameable && framesAppHere(frameable, window.location.origin) ? frameable : undefined;
  const session = tcw?.session();
  if (framed && (!tcw || !session)) return <>{fallback}</>;
  const url = appUrl(app);
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="one-app-screen">
      <AppBar name={app.name} glyph={app.glyph} accountDid={accountDid} pin={appPinId(app.id)} url={url} />
      {framed && tcw && session ? (
        <FramedApp key={`${framed.id}:${session.address}:${session.chainId}:${session.sessionKey}`} app={framed} tcw={tcw} address={session.address} chainId={session.chainId} connect={connect} />
      ) : (
        <OpensSeparately name={app.name} glyph={app.glyph} url={url} phone={platform === "ios" || platform === "android"} />
      )}
    </div>
  );
}

/** An app One can't frame here (it is never framed, or not on this origin or platform): it opens on its own. */
function OpensSeparately({ name, glyph, url, phone }: { name: string; glyph: GlyphId; url: string; phone: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-scroll-root>
      <div className="mx-auto flex min-h-full max-w-sm flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <AppTileIcon id={glyph} className="mb-2 size-16" />
        <h2 className="text-title-2 text-foreground">{opensSeparatelyTitle(name, phone)}</h2>
        <p className="text-body text-muted-foreground">{opensSeparatelyLine(name)}</p>
        <Button asChild className="mt-2">
          <a href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => openLinkInApp(url, event.nativeEvent, { sheet: false })}>
            {openSeparately(name, phone)}
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
      delegate: async (audience, entries) => {
        let made: Awaited<ReturnType<TinyCloudWeb["delegateTo"]>>;
        try {
          made = await tcw.delegateTo(audience, entries, { expiry: GRANT_LIFETIME_MS, disableSubDelegation: true, requireActivation: true });
        } catch (error) {
          if (skippedByNode(error) && entries[0]?.space) throw new SpaceNotHostedError(entries[0].space);
          throw error;
        }
        const { delegation, prompted } = made;
        return {
          spaceId: delegation.spaceId,
          cid: delegation.cid,
          delegation: serializeDelegation(delegation),
          expiresAt: new Date(delegation.expiry).getTime(),
          prompted,
        };
      },
      stepUp: (scopes, entries, missingSpaces) => askThenStepUp(scopes, entries, missingSpaces),
      missing: (spaces, none) => {
        setFailedLine(null);
        setMissing({ spaces, none });
      },
      theme: () => themeRef.current,
      onError: (error) => console.warn("[One Apps] embed message failed", app.id, error),
    });
    hostRef.current = host;
    const onMessage = (event: MessageEvent) => { void host.handle(event); };
    window.addEventListener("message", onMessage);
    const untrack = trackEmbed(() => host.close());
    return () => {
      window.removeEventListener("message", onMessage);
      untrack();
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
