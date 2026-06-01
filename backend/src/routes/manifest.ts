import { Router } from "express";
import { runtimeManifest } from "../manifest.js";

export function createManifestRouter() {
  const router = Router();
  router.get("/", (_req, res) => {
    res.json(runtimeManifest());
  });
  return router;
}
