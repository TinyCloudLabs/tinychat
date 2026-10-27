import { Router } from "express";
import { runtimeManifest } from "../manifest.js";

/**
 * `GET /api/manifest?keys=1` serves the manifest with its named-key rows
 * (`keys_app_id` and `keys`). Without the opt-in the response is the same
 * manifest minus those two fields, which is the shape clients built before
 * named keys read. Only a client that signs in through OpenKey's authorize
 * review (where app keys are admitted) sends the opt-in.
 */
export function createManifestRouter() {
  const router = Router();
  router.get("/", (req, res) => {
    const manifest = runtimeManifest();
    if (req.query.keys === "1") {
      res.json(manifest);
      return;
    }
    const { keys_app_id: _keysAppId, keys: _keys, ...withoutKeyRows } = manifest;
    res.json(withoutKeyRows);
  });
  return router;
}
