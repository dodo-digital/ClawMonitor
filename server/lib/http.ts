import type { NextFunction, Request, Response } from "express";

import { HttpError } from "./errors.js";

export function ok<T>(res: Response, data: T, status = 200): void {
  res.status(status).json({ ok: true, data });
}

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: "Not found" });
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (error instanceof HttpError) {
    res.status(error.status).json({ ok: false, error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  console.error(error);
  res.status(500).json({ ok: false, error: message });
}
