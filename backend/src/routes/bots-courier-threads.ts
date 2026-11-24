// Mounted inside C1's flag/account/auth gate. The browser never chooses an owner or a reply destination.
// Details: TC-4058
import type { Router } from "express";
import type { CourierRouterDeps } from "./bots-courier.js";

export function mountCourierThreads(router: Router, deps: CourierRouterDeps): void {
  router.get("/threads", async (req, res) => {
    try {
      const response = await deps.callBots(req.user!.address, "GET", "/courier/threads");
      if (!response.ok) { res.status(503).json({ error: "courier_unavailable" }); return; }
      res.setHeader("cache-control", "no-store");
      res.json(await response.json());
    } catch { res.status(503).json({ error: "courier_unavailable" }); }
  });
  router.get("/threads/:id", async (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.id)) { res.status(404).end(); return; }
    try {
      const response = await deps.callBots(req.user!.address, "GET", `/courier/threads/${req.params.id}`);
      if (response.status === 404) { res.status(404).end(); return; }
      if (!response.ok) { res.status(503).json({ error: "courier_unavailable" }); return; }
      res.setHeader("cache-control", "no-store");
      res.json(await response.json());
    } catch { res.status(503).json({ error: "courier_unavailable" }); }
  });
  router.delete("/threads/:id", async (req, res) => {
    if (!/^[0-9a-f]{64}$/.test(req.params.id)) { res.status(404).end(); return; }
    try {
      const response = await deps.callBots(req.user!.address, "DELETE", `/courier/threads/${req.params.id}`);
      if (!response.ok) { res.status(503).json({ error: "courier_unavailable" }); return; }
      res.status(204).end();
    } catch { res.status(503).json({ error: "courier_unavailable" }); }
  });
}
