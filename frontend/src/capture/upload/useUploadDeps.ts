// What the upload runner needs to start, resume or finish an upload (TC-761):
// one place, used by the Upload sheet, the launch resumer and the In progress
// row's Continue. The upload's storage calls take turns with the Library's
// reads on this space (lib/spaceQueue.ts); the vault (secrets) is not storage
// and is not queued.
import { useMemo } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  AssemblyAiError,
  createAssemblyAiClient,
  createHostedAssemblyAiClient,
  readAssemblyAiKey,
} from "@/lib/assemblyai";
import type { UploadDeps } from "@/lib/audioUpload";
import { createLocalTranscriptSaver } from "@/lib/localTranscriber";
import { buildPtxUploadOrigin, createPrivateCloudApi, createPrivateCloudJob, type PrivateCloudApi } from "@/lib/privateCloud";
import { scheduledSpace } from "@/lib/spaceQueue";

type HostedAssemblyAiClient = ReturnType<typeof createHostedAssemblyAiClient>;

export interface UploadDepsInput {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** The private cloud relay's origin in this build, or null. */
  origin: string | null;
  api: PrivateCloudApi;
  hosted: HostedAssemblyAiClient;
  /** Reads the user's own AssemblyAI key from the vault (unlocking it); injectable for tests. */
  readKey?: typeof readAssemblyAiKey;
}

export function buildUploadDeps({ tcw, backendUrl, sessionStore, origin, api, hosted, readKey = readAssemblyAiKey }: UploadDepsInput): UploadDeps {
  const space = scheduledSpace(tcw);
  return {
    tcw: space,
    // Not gated on capabilities: a job started earlier must still resume; the relay itself refuses new ones.
    privateCloud:
      origin !== null ? { api, origin, create: (request) => createPrivateCloudJob(backendUrl, { sessionStore }, request) } : null,
    // Exactly the account the job was started with: a job never moves between TinyCloud's and the user's.
    assemblyAiClient: async (mode) => {
      if (mode === "hosted") return hosted;
      const read = await readKey(tcw);
      if (!read.ok) throw new Error(read.message);
      if (read.data === null) throw new AssemblyAiError("invalid-key", "No AssemblyAI API key is saved. Add one in Settings → Transcription.");
      return createAssemblyAiClient(read.data, { backend: { url: backendUrl, sessionStore } });
    },
    save: createLocalTranscriptSaver(space),
  };
}

export interface UploadClients {
  deps: UploadDeps;
  origin: string | null;
  api: PrivateCloudApi;
  hosted: HostedAssemblyAiClient;
}

export function useUploadDeps(tcw: TinyCloudWeb, backendUrl: string, sessionStore: SessionStore): UploadClients {
  const origin = useMemo(() => buildPtxUploadOrigin(), []);
  const api = useMemo(() => createPrivateCloudApi(backendUrl, { sessionStore }), [backendUrl, sessionStore]);
  const hosted = useMemo(() => createHostedAssemblyAiClient({ backendUrl, sessionStore }), [backendUrl, sessionStore]);
  const deps = useMemo(
    () => buildUploadDeps({ tcw, backendUrl, sessionStore, origin, api, hosted }),
    [tcw, backendUrl, sessionStore, origin, api, hosted],
  );
  return { deps, origin, api, hosted };
}
