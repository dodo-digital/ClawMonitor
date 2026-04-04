import { Router } from "express";

import { asyncHandler, ok } from "../lib/http.js";

export const healthRouter = Router();

healthRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    ok(res, { status: "ok" });
  }),
);
