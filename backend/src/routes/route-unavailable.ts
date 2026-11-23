import type { Response } from "express";

/**
 * The marker on a 404 this backend itself sends for a connector credential route that is not
 * available to the caller: not mounted (flag off), or the signed-in address is not enrolled. A
 * client forgives such a 404 as "nothing stored here"; a 404 without the marker comes from
 * somewhere else (a proxy, a wrong path) and is a failure. The value names no flag or cohort.
 */
export const ROUTE_UNAVAILABLE_HEADER = "X-Route-Unavailable";
export const CREDENTIALS_ROUTE_UNAVAILABLE = "connector-credentials";

/** The 404 body is unchanged; only the marker header is added. */
export function credentialRouteUnavailable(res: Response): void {
  res.setHeader(ROUTE_UNAVAILABLE_HEADER, CREDENTIALS_ROUTE_UNAVAILABLE);
  res.status(404).json({ error: "not_found" });
}

/** Marks the 404 for the Fireflies import routes while the server import is off, so a client can tell it from a proxy's 404. */
export const FIREFLIES_IMPORT_ROUTE_UNAVAILABLE = "fireflies-import";

export function firefliesImportRouteUnavailable(res: Response): void {
  res.setHeader(ROUTE_UNAVAILABLE_HEADER, FIREFLIES_IMPORT_ROUTE_UNAVAILABLE);
  res.status(404).json({ error: "not_found" });
}
