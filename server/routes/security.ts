import { Router } from "express";

import { asyncHandler, ok } from "../lib/http.js";
import {
  computeComplianceScore,
  getLatestSecurityScan,
  getSecurityHistory,
  saveSecurityBaseline,
  saveSecurityScan,
} from "../monitor/checks/security.js";

export const securityRouter = Router();

// Run a full compliance scan
securityRouter.get(
  "/scan",
  asyncHandler(async (_req, res) => {
    const report = await computeComplianceScore();
    saveSecurityScan(report);
    ok(res, report);
  }),
);

// Get the latest cached scan without re-running
securityRouter.get(
  "/latest",
  asyncHandler(async (_req, res) => {
    const latest = getLatestSecurityScan();
    ok(res, latest);
  }),
);

// Get scan history
securityRouter.get(
  "/history",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
    ok(res, { items: getSecurityHistory(limit) });
  }),
);

// Save the current skill set as the new baseline
securityRouter.post(
  "/baseline",
  asyncHandler(async (_req, res) => {
    const result = await saveSecurityBaseline();
    ok(res, result);
  }),
);
