// TC-3716: where the Report a bug sheet comes from. Mounted only when VITE_REPORT_BUG is on.
// - Settings → Report a bug opens it on every platform.
// - iPhone and Android 14+: the ScreenshotReport plugin's screenshot event offers it, with the app's own snapshot.
// - Web and the Mac app: keyboard and focus signs of a screenshot offer it (webDetector.ts), with no image; the
//   person can pick or paste one.
// The offer setting and offerPolicy.ts decide whether a screenshot opens it by itself.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { useAppUnlocked } from "@/lib/appLock";
import { resolveBuildInfo } from "@/lib/buildInfo";
import { appPlatform } from "@/lib/platform";
import { APP_STARTED_AT, FEEDBACK_ORIGIN, onReportBugRequest, screenSensitiveHeld, useOfferAfterScreenshot } from "@/lib/reportBug/config";
import { osMajor, reportErrors, type RecentErrorLine, type ReportContext, type ReportTrigger } from "@/lib/reportBug/context";
import { snapshotBytes, type JpegBytes } from "@/lib/reportBug/image";
import { nativeScreenshotReport } from "@/lib/reportBug/nativeScreenshot";
import { createOfferPolicy } from "@/lib/reportBug/offerPolicy";
import { redactForReport } from "@/lib/reportBug/redact";
import { signerFromTcw } from "@/lib/reportBug/send";
import { createWebScreenshotDetector } from "@/lib/reportBug/webDetector";
import { ReportBugSheet } from "./ReportBugSheet";

interface OpenSheet {
  key: number;
  trigger: ReportTrigger;
  screenshot: { bytes: JpegBytes; sensitive: boolean } | null;
  context: ReportContext;
  recentErrors: RecentErrorLine[];
}

export interface ReportBugHostProps {
  tcw: TinyCloudWeb | null;
  /** The current screen's id (shell/routes.ts). */
  screenId: string;
  /** Screens that can show private details (account settings, a framed app, a share link): the snapshot starts detached. */
  sensitive: boolean;
}

export default function ReportBugHost({ tcw, screenId, sensitive }: ReportBugHostProps) {
  const platform = appPlatform();
  const unlocked = useAppUnlocked();
  const offerOn = useOfferAfterScreenshot();
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const [open, setOpen] = useState(false);
  const [policy] = useState(() => createOfferPolicy(APP_STARTED_AT));
  const sentRef = useRef(false);
  // The screenshot listeners are long-lived; they read the current screen and state from here.
  const live = useRef({ screenId, sensitive, unlocked, open, signedIn: false });
  live.current = { screenId, sensitive, unlocked, open, signedIn: signerFromTcw(tcw) !== null };

  // Recent errors belong to the account that was signed in.
  const hadTcw = useRef(tcw !== null);
  useEffect(() => {
    if (hadTcw.current && !tcw) reportErrors.clear();
    hadTcw.current = tcw !== null;
  }, [tcw]);

  const show = useCallback(async (trigger: ReportTrigger, shot: { bytes: JpegBytes; sensitive: boolean } | null) => {
    const now = Date.now();
    const os = osMajor(platform, navigator.userAgent);
    const context: ReportContext = {
      app: await resolveBuildInfo(platform),
      platform,
      ...(os ? { os } : {}),
      screen: live.current.screenId,
      client_time: new Date(now).toISOString(),
      online: navigator.onLine,
      trigger,
    };
    sentRef.current = false;
    setSheet((previous) => ({
      key: (previous?.key ?? 0) + 1,
      trigger,
      screenshot: shot,
      context,
      recentErrors: reportErrors.recent(now, redactForReport),
    }));
    setOpen(true);
  }, [platform]);

  useEffect(() => onReportBugRequest(() => { if (!live.current.open) void show("menu", null); }), [show]);

  // Phones: the native screenshot event, with the app's own snapshot (signed in only: unsigned reports carry none).
  useEffect(() => {
    if (!offerOn) return;
    const plugin = nativeScreenshotReport();
    if (!plugin) return;
    let disposed = false;
    const handle = plugin.addListener("screenshot", ({ id }) => {
      if (!policy.offer(id, Date.now(), { locked: !live.current.unlocked, sheetOpen: live.current.open })) return;
      // What was on screen when the screenshot was taken decides whether its snapshot starts detached.
      const sensitive = live.current.sensitive || screenSensitiveHeld();
      void (async () => {
        const shot = live.current.signedIn ? await plugin.takeSnapshot({ id }).catch(() => null) : null;
        const bytes = shot ? snapshotBytes(shot.jpegBase64) : null;
        if (!disposed) void show("screenshot", bytes ? { bytes, sensitive } : null);
      })();
    });
    void plugin.start();
    return () => {
      disposed = true;
      void handle.then((h) => h.remove());
      void plugin.stop();
    };
  }, [offerOn, policy, show]);

  // Web and the Mac app: keyboard and focus signs.
  useEffect(() => {
    if (!offerOn || (platform !== "web" && platform !== "tauri")) return;
    return createWebScreenshotDetector({
      target: window,
      document,
      now: Date.now,
      onScreenshot: (id) => { if (policy.offer(id, Date.now(), { locked: !live.current.unlocked, sheetOpen: live.current.open })) void show("screenshot", null); },
    });
  }, [offerOn, platform, policy, show]);

  if (!sheet) return null;
  return (
    <ReportBugSheet
      key={sheet.key}
      open={open}
      trigger={sheet.trigger}
      screenshot={sheet.screenshot}
      signer={signerFromTcw(tcw)}
      canAttachFile={platform === "web" || platform === "tauri"}
      context={sheet.context}
      recentErrors={sheet.recentErrors}
      origin={FEEDBACK_ORIGIN}
      onSent={() => { sentRef.current = true; policy.sent(); }}
      onOpenChange={(next) => {
        if (next) return;
        setOpen(false);
        if (!sentRef.current && sheet.trigger === "screenshot") policy.dismissed(Date.now());
        // Drop the note and the screenshot with the sheet.
        setSheet(null);
      }}
    />
  );
}
