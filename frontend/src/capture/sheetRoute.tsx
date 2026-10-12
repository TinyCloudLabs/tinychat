// "Where your audio goes" for the Upload and Meeting sheets (plan §2.7): the
// routes they draw with the recorder's RouteLine (capture/recorder/RouteLine).
import type { AssemblyAiKeyMode } from "@/lib/assemblyai";
import type { UploadEngine } from "@/lib/audioUpload";
import { appPlatform, type AppPlatform } from "@/lib/platform";
import { routeSourceName, TRANSCRIBER_NAME } from "./recorder/final/finalCopy";
import type { RouteNode } from "./recorder/RouteLine";

/** An upload: through private cloud or AssemblyAI under TinyCloud's account. */
export function uploadRoute(engine: UploadEngine, assemblyAiMode: AssemblyAiKeyMode, platform: AppPlatform = appPlatform()): RouteNode[] {
  const powerful = TRANSCRIBER_NAME.assemblyai;
  const via =
    engine === "private-cloud" ? TRANSCRIBER_NAME["private-cloud"] : assemblyAiMode === "hosted" ? `${powerful} · TinyCloud's account` : `${powerful} · choose file again`;
  return [
    { label: routeSourceName(platform), kind: "source" },
    { label: via, kind: "processing" },
    { label: "Your space", kind: "destination" },
  ];
}

export const NOTETAKER_ROUTE: readonly RouteNode[] = [
  { label: "Meeting", kind: "source" },
  { label: "TinyCloud notetaker", kind: "processing" },
  { label: "Your space", kind: "destination" },
];
