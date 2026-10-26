import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getSetting, setSetting } from "../lib/threadStore";

export type FirstScreen = "feed" | "apps";
const FIRST_SCREEN_KEY = "home-first-screen";

export async function readFirstScreen(tcw: TinyCloudWeb): Promise<FirstScreen> {
  return (await getSetting(tcw, FIRST_SCREEN_KEY)) === "apps" ? "apps" : "feed";
}

export function writeFirstScreen(tcw: TinyCloudWeb, screen: FirstScreen): Promise<void> {
  return setSetting(tcw, FIRST_SCREEN_KEY, screen);
}
