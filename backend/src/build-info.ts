import { readFileSync } from "node:fs";

/**
 * What this process was built from, published by /api/server-info so a deploy can prove the new build is live:
 * `backendRevision` is the commit baked into the image (Dockerfile ARG/ENV BUILD_REVISION, set by the deploy
 * workflow to the deployed commit) and `backendVersion` is backend/package.json's version in the image. Both are
 * read once at startup and never change for the life of the process.
 */
export interface BackendBuildInfo {
  backendRevision: string;
  backendVersion: string;
}

export function readBackendBuildInfo(env: NodeJS.ProcessEnv = process.env): BackendBuildInfo {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof version !== "string" || version === "") throw new Error("backend/package.json has no version");
  return Object.freeze({ backendRevision: env.BUILD_REVISION || "unknown", backendVersion: version });
}
