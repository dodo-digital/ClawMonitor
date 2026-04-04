import { Router } from "express";

import { asyncHandler, ok } from "../lib/http.js";
import { HttpError } from "../lib/errors.js";
import { getIncidentDetail, listIncidents } from "../monitor/incidents/store.js";
import { gatherDigestData } from "../monitor/notifications/digest.js";
import type { MonitorScheduler } from "../monitor/scheduler.js";
import { DEFAULT_WORKSPACE_ID } from "../monitor/workspace.js";

export const monitorRouter = Router();

monitorRouter.get(
  "/incidents",
  asyncHandler(async (_req, res) => {
    ok(res, { items: listIncidents(DEFAULT_WORKSPACE_ID) });
  }),
);

monitorRouter.get(
  "/digest/preview",
  asyncHandler(async (_req, res) => {
    ok(res, gatherDigestData());
  }),
);

monitorRouter.post(
  "/digest/send",
  asyncHandler(async (req, res) => {
    const scheduler = req.app.locals.monitorScheduler as MonitorScheduler | undefined;
    if (!scheduler) {
      throw new HttpError("Monitor scheduler not available", 503);
    }
    await scheduler.sendDigestNow();
    ok(res, { sent: true });
  }),
);

monitorRouter.get(
  "/incidents/:id",
  asyncHandler(async (req, res) => {
    const incident = getIncidentDetail(DEFAULT_WORKSPACE_ID, Number(req.params.id));
    if (!incident) {
      throw new HttpError("Incident not found", 404);
    }

    ok(res, incident);
  }),
);
