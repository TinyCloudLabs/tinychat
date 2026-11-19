// `/chat/apps/<appId>`: one of TinyCloud's apps framed inside One, running on a silent, scoped delegation of One's
// session (CONTRACT.md). Lazy: loads only when the flag is on and an app route is open.

import { serializeDelegation, type PermissionEntry, type TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { useResolvedTheme } from "../lib/theme";
import { EmbedHost, type EmbedTheme } from "./embedHost";
import { trackEmbed } from "./liveEmbeds";
import { framedApp, framesAppsHere, frameUrl, type FramedOneApp } from "./registry";
import { stepUpForApp } from "./stepUp";
import { ASK_CONTINUE, ASK_NOT_NOW, askBody, askDeclined, askTitle, joinScopes, type ScopeId } from "./strings";

const GRANT_LIFETIME_MS = 60 * 60 * 1000;
const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads";

interface Ask {
  scopes: ScopeId[];
  answer(proceed: boolean): void;
}

export interface FramedAppScreenProps {
  appId: string;
  tcw: TinyCloudWeb | null;
  /** Shown instead when the app is not framed here (unknown id, opens in a new tab, other origin, no session). */
  fallback: ReactNode;
}

export function FramedAppScreen({ appId, tcw, fallback }: FramedAppScreenProps) {
  const app = framedApp(appId);
  const session = tcw?.session();
  if (!app || !tcw || !session || !framesAppsHere(window.location.origin)) return <>{fallback}</>;
  return <FramedApp key={`${app.id}:${session.address}:${session.chainId}:${session.sessionKey}`} app={app} tcw={tcw} address={session.address} chainId={session.chainId} />;
}

// Keyed by app, owner and session key: a different app or One session is a fresh frame, host and grant.
function FramedApp({ app, tcw, address, chainId }: { app: FramedOneApp; tcw: TinyCloudWeb; address: string; chainId: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useResolvedTheme();
  const themeRef = useRef<EmbedTheme>(theme);
  themeRef.current = theme;
  const [ask, setAsk] = useState<Ask | null>(null);
  const [declined, setDeclined] = useState(false);
  const src = useMemo(() => frameUrl(app), [app]);
  const hostRef = useRef<EmbedHost | null>(null);

  // One host per mount: its close revokes for good, so a remount (StrictMode included) starts a fresh one.
  useEffect(() => {
    const host = new EmbedHost({
      app,
      owner: { address, chainId },
      frameWindow: () => frameRef.current?.contentWindow ?? null,
      post: (message) => frameRef.current?.contentWindow?.postMessage(message, app.origin),
      holds: (entries) => tcw.hasPermissions(entries),
      delegate: async (audience, entries) => {
        const { delegation, prompted } = await tcw.delegateTo(audience, entries, { expiry: GRANT_LIFETIME_MS, disableSubDelegation: true });
        return {
          spaceId: delegation.spaceId,
          cid: delegation.cid,
          delegation: serializeDelegation(delegation),
          expiresAt: new Date(delegation.expiry).getTime(),
          prompted,
        };
      },
      revoke: async (cid) => {
        const result = await tcw.revokeDelegation(cid);
        if (!result.ok) throw new Error(`one_apps_revoke_failed:${cid}`);
      },
      stepUp: (scopes, entries) => askThenStepUp(scopes, entries),
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

  function askThenStepUp(scopes: ScopeId[], entries: PermissionEntry[]): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      setDeclined(false);
      setAsk({ scopes, answer: (proceed) => {
        if (settled) return;
        settled = true;
        setAsk(null);
        if (!proceed) {
          setDeclined(true);
          resolve(false);
          return;
        }
        stepUpForApp(tcw, entries).then(resolve, (error: unknown) => {
          console.warn("[One Apps] step-up failed", app.id, error);
          resolve(false);
        });
      } });
    });
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col" data-testid="one-app-frame">
      {declined && (
        <p role="status" className="border-b border-border bg-muted px-4 py-2 text-sm">{askDeclined(app.name)}</p>
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
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => ask?.answer(false)}>{ASK_NOT_NOW}</AlertDialogCancel>
            <AlertDialogAction onClick={() => ask?.answer(true)}>{ASK_CONTINUE}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
