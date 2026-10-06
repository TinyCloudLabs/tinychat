// "Where your audio goes" for the Upload and Meeting sheets (plan §2.7): the
// route as a small node-and-line diagram. The source is filled with ink,
// processing stops are hollow, and the user's space is filled with primary;
// once the transcript has landed, that last node carries a check.
//
// The recorder's capture/recorder/RouteLine (PR4) has the same API and
// markup. When both are in, this file keeps only the route builders and takes
// RouteLine from there.
import { CheckIcon } from "lucide-react";

import type { AssemblyAiKeyMode } from "@/lib/assemblyai";
import type { UploadEngine } from "@/lib/audioUpload";
import { cn } from "@/lib/utils";

export interface RouteNode {
  label: string;
  kind: "source" | "processing" | "destination";
}

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

function Node(props: { kind: RouteNode["kind"]; landed: boolean }) {
  if (props.kind === "destination" && props.landed) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-500">
        <CheckIcon className="size-3" strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "size-2.5 shrink-0 rounded-full",
        props.kind === "source" && "bg-foreground",
        props.kind === "processing" && "border-[1.5px] border-muted-foreground",
        props.kind === "destination" && "bg-primary",
      )}
    />
  );
}

export function RouteLine(props: { nodes: readonly RouteNode[]; landed?: boolean; className?: string }) {
  const landed = props.landed ?? false;
  return (
    <ol
      aria-label="Where your audio goes"
      data-route-line=""
      data-landed={landed ? "" : undefined}
      className={cn("flex w-full items-start", props.className)}
    >
      {props.nodes.map((node, index) => {
        const last = index === props.nodes.length - 1;
        return (
          <li key={node.label} data-node={node.kind} className={cn("flex min-w-0 flex-col gap-1.5", last ? "shrink-0" : "flex-1")}>
            <span className="flex h-4 items-center" aria-hidden="true">
              <Node kind={node.kind} landed={landed && last} />
              {!last && <span className="mx-1.5 h-[1.5px] flex-1 rounded-full bg-muted-foreground/40" />}
            </span>
            <span className="pr-2 text-meta text-muted-foreground">
              {node.label}
              {landed && last && <span className="sr-only"> (saved)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
