// Picks up an upload a reload interrupted, at launch, without opening the
// Upload sheet (TC-761). Headless: App mounts it after the other workers,
// under the same gate. Once ready it runs the resume guard: a private cloud
// or TinyCloud-account job resumes at once, and so does an own-key job when
// the vault is already open. An own-key job with the vault locked is left
// alone, because resuming reads the key and reading it unlocks the vault,
// which prompts, and nothing unlocks on mount. It waits as "Upload paused ·
// Continue" (pausedUpload) until the user taps Continue.
import { useEffect } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { uploadRunner, type UploadDeps, type UploadRunner } from "@/lib/audioUpload";
import { isSecretsUnlocked } from "@/lib/connectors/connectorSecrets";
import { resumeUnlessLocked } from "@/lib/uploadResume";
import { pausedUpload } from "./pausedUpload";
import { useUploadDeps } from "./useUploadDeps";

/** The launch step: resume the stored upload, or publish it as paused when resuming would unlock the vault. */
export function resumeOnLaunch(runner: Pick<UploadRunner, "resume">, deps: UploadDeps, secretsUnlocked: boolean): void {
  const stored = resumeUnlessLocked(runner, deps, secretsUnlocked);
  pausedUpload.set(stored === null ? null : { fileName: stored.file.name });
}

export function UploadResumer(props: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }) {
  const { deps } = useUploadDeps(props.tcw, props.backendUrl, props.sessionStore);
  const { tcw } = props;
  useEffect(() => {
    resumeOnLaunch(uploadRunner, deps, isSecretsUnlocked(tcw));
    // Signed out (the gate closed): the paused upload belongs to that account.
    return () => pausedUpload.set(null);
  }, [deps, tcw]);
  return null;
}
