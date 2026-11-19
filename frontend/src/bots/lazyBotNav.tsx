// The bots' rows in the sidebar and on the rail (BotNav.tsx), from the Bots view's chunk: they show only while the Bots
// view is mounted (botsNav.ts), and the Chat slot has started loading them by then (ChatSlot.tsx).
import { lazyTab } from "@/shell/lazyTab";
import { useBotsNav } from "./botsNav";

const LazySidebarBotRows = lazyTab("Chat", () => import("./BotNav").then((m) => m.SidebarBotRows));
const LazyRailBotAvatars = lazyTab("Chat", () => import("./BotNav").then((m) => m.RailBotAvatars));

export const preloadBotNav = () => Promise.all([LazySidebarBotRows.preload(), LazyRailBotAvatars.preload()]);

export function SidebarBotRows() {
  return useBotsNav() ? <LazySidebarBotRows /> : null;
}

export function RailBotAvatars() {
  return useBotsNav() ? <LazyRailBotAvatars /> : null;
}
