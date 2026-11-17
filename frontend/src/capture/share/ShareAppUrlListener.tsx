// TC-3195: the phone app opened a share link (an App Link / Universal Link): show its in-app page. OAuth returns are
// not share links.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";

import { holdShareLinkUrl } from "@/lib/nativeShares/link";

// The URL the app was launched with stays the launch URL for the whole process, so it is handled once: going back to
// it after every navigation would open (and add) the share again and again.
let launchUrlHandled = false;

export function ShareAppUrlListener() {
  const navigate = useNavigate();
  // `navigate` changes identity as the route changes; the listener reads the latest without re-subscribing.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  useEffect(() => {
    const open = (url: string | undefined) => {
      const path = url ? holdShareLinkUrl(url) : null;
      if (path) navigateRef.current(path);
    };
    if (!launchUrlHandled) {
      launchUrlHandled = true;
      void CapacitorApp.getLaunchUrl().then((launch) => open(launch?.url)).catch(() => undefined);
    }
    const listener = CapacitorApp.addListener("appUrlOpen", (event) => open(event.url));
    return () => void listener.then((handle) => handle.remove());
  }, []);
  return null;
}
