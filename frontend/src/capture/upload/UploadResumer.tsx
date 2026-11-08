// Picks up an upload a reload interrupted, at launch, without opening the
// Upload sheet (TC-761). Headless: App mounts it after the other workers,
// under the same gate. Once ready it resumes the stored upload.
import { useEffect } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { uploadRunner, type UploadDeps, type UploadRunner } from "@/lib/audioUpload";
import { useUploadDeps } from "./useUploadDeps";

/** The launch step: resume the stored upload. */
export function resumeOnLaunch(runner: Pick<UploadRunner, "resume">, deps: UploadDeps): void {
  runner.resume(deps);
}

export function UploadResumer(props: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }) {
  const { deps } = useUploadDeps(props.tcw, props.backendUrl, props.sessionStore);
  useEffect(() => {
    resumeOnLaunch(uploadRunner, deps);
  }, [deps]);
  return null;
}
