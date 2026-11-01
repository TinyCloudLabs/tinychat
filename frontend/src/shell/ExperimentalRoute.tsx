import { type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAppsFeedEnabled } from "../lib/appsFeedFeature";
import { PATHS } from "./routes";

/** Redirect before mounting Feed or Apps, so neither surface starts background work. */
export function ExperimentalRoute({ children }: { children: ReactNode }) {
  const enabled = useAppsFeedEnabled();
  const { pathname, search, hash } = useLocation();
  const experimental = [PATHS.feed, PATHS.apps].some((root) => pathname === root || pathname.startsWith(`${root}/`));
  if (!enabled && experimental) return <Navigate to={{ pathname: PATHS.chat, search, hash }} replace />;
  return children;
}
