import { lazy } from "react";

/**
 * The feed lab (feed/FeedLab.tsx): the real Home feed cards on made-up data, with
 * no sign-in, for trying card interactions. Only a build made with
 * VITE_FEED_LAB=true has it. Vite inlines the flag, so every other build has no
 * lab code, route or link, and is byte for byte what it would be without it.
 */
export const FEED_LAB = import.meta.env.VITE_FEED_LAB === "true";
export const FEED_LAB_PATH = "/feed-lab";

/** The lab's routes, loaded on demand; null in every build without the lab, which emits no chunk for it. */
export const FeedLabRoutes = FEED_LAB ? lazy(() => import("../feed/FeedLab")) : null;
