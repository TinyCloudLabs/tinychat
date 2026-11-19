// TC-3195: the phone app opened a share link (an App Link / Universal Link): show its in-app page. OAuth returns are
// not share links.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { App as CapacitorApp } from "@capacitor/app";

import { holdShareLinkUrl, shareLinkId } from "@/lib/nativeShares/link";

// The URL the app was launched with stays the launch URL for the whole process, so each launch link is consumed once,
// by its id: going back to it after every navigation would open the share again and again.
const consumedLaunchLinks = new Set<string>();

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
    void CapacitorApp.getLaunchUrl().then((launch) => {
      const url = launch?.url;
      const id = url ? shareLinkId(url) : null;
      if (!url || !id || consumedLaunchLinks.has(id)) return;
      consumedLaunchLinks.add(id);
      open(url);
    }).catch(() => undefined);
    const listener = CapacitorApp.addListener("appUrlOpen", (event) => open(event.url));
    return () => void listener.then((handle) => handle.remove());
  }, []);
  return null;
}
