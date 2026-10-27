import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { applyTinyCloudButton, useTinyCloudButtonShown } from "../lib/tinycloudButton";

/** Renders nothing. Keeps the SDK's floating button in step with Settings > TinyCloud: on load, and on every change. */
export function TinyCloudButtonSync({ tcw }: { tcw: TinyCloudWeb }) {
  const shown = useTinyCloudButtonShown();
  useEffect(() => { applyTinyCloudButton(tcw, shown); }, [tcw, shown]);
  return null;
}
