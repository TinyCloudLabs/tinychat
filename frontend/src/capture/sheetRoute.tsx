// "Where your audio goes" for the Upload and Meeting sheets (plan §2.7): the
// routes they draw with the recorder's RouteLine (capture/recorder/RouteLine).
import type { AssemblyAiKeyMode } from "@/lib/assemblyai";
import type { UploadEngine } from "@/lib/audioUpload";
import type { RouteNode } from "./recorder/RouteLine";

/** An upload: through private cloud, or through AssemblyAI under TinyCloud's account or the user's key. */
export function uploadRoute(engine: UploadEngine, assemblyAiMode: AssemblyAiKeyMode): RouteNode[] {
  const via =
    engine === "private-cloud" ? "Private cloud" : assemblyAiMode === "hosted" ? "AssemblyAI · TinyCloud's account" : "AssemblyAI · your key";
  return [
    { label: "This device", kind: "source" },
    { label: via, kind: "processing" },
    { label: "Your space", kind: "destination" },
  ];
}

export const NOTETAKER_ROUTE: readonly RouteNode[] = [
  { label: "Meeting", kind: "source" },
  { label: "TinyCloud notetaker", kind: "processing" },
  { label: "Your space", kind: "destination" },
];
