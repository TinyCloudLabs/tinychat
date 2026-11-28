import type { DelegatedAccess, SessionRenewal } from "@tinyboilerplate/server";

declare global {
  namespace Express {
    interface Request {
      user?: {
        address: string;
        /** Set only from a bearer `/api/auth/verify-renewal` issued; never from a request body. */
        renewal?: SessionRenewal;
      };
      delegatedAccess?: DelegatedAccess;
    }
  }
}
