import type { DelegatedAccess } from "@tinyboilerplate/server";

declare global {
  namespace Express {
    interface Request {
      user?: {
        address: string;
      };
      delegatedAccess?: DelegatedAccess;
    }
  }
}
