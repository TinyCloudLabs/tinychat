import { useContext, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { PlatformContext } from "@/lib/platform";
import { useRecorder } from "../../RecorderProvider";
import { showToast } from "../desktop/Toasts";
import { recorderLayout, type RecorderLayout } from "../shellCapabilities";
import { useKeepOpenToast } from "./keepOpenToast";
import { useLeaveGuard } from "./useLeaveGuard";
import { useRecordingTitle } from "./recordingTitle";
import { useWakeLock } from "./useWakeLock";

const PHONE_TOAST_MS = 3200;

function useWindowLayout(): RecorderLayout {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return recorderLayout(width);
}

/** The phone-width recorder has no Toasts host of its own to reach from here, so its notice sits over the page. */
export function PhoneToast({ message }: { message: string }) {
  return createPortal(
    <div
      role="status"
      data-testid="shell-toast"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top,0px)+18px)] z-[70] flex justify-center px-6"
    >
      <div className="rounded-full bg-foreground px-4 py-2 text-callout font-semibold text-background">{message}</div>
    </div>,
    document.body,
  );
}

/**
 * What the browser shell adds around a recording: the tab title, a screen wake lock, the
 * leave-page guard and the keep-open notice. Mounted once in the stable recorder owner, as its own
 * component so the title's per-second ticks re-render only this and not the app shell.
 */
export function ShellChrome() {
  const recorder = useRecorder();
  const web = useContext(PlatformContext) === "web";
  const layout = useWindowLayout();
  const live = recorder.phase === "recording";
  const [phoneToast, setPhoneToast] = useState<{ message: string; key: number } | null>(null);

  useRecordingTitle();
  useWakeLock(web && live && recorder.mic.state !== "paused");
  useLeaveGuard(web && live);
  useKeepOpenToast(web, recorder.phase, layout, (message) =>
    layout === "phone" ? setPhoneToast({ message, key: Date.now() }) : showToast(message),
  );

  useEffect(() => {
    if (!phoneToast) return;
    const timer = setTimeout(() => setPhoneToast(null), PHONE_TOAST_MS);
    return () => clearTimeout(timer);
  }, [phoneToast]);

  return phoneToast ? <PhoneToast key={phoneToast.key} message={phoneToast.message} /> : null;
}
