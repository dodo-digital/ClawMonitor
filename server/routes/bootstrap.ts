import fs from "node:fs";
import path from "node:path";

import { Router } from "express";

import {
  BOOTSTRAP_BUDGET_MAX,
  BOOTSTRAP_FILES,
  BOOTSTRAP_FILE_BUDGET_MAX,
  BOOTSTRAP_FILE_NAMES,
  BOOTSTRAP_WRITE_LIMIT,
  BOOTSTRAP_WRITE_WINDOW_MS,
} from "../lib/constants.js";
import {
  getIdentityVersion,
  insertIdentityVersion,
  listIdentityVersionCountsByFile,
  listIdentityVersions,
  updateIdentityVersionLabel,
} from "../lib/db.js";
import { env } from "../lib/env.js";
import { HttpError } from "../lib/errors.js";
import { safeReadTextFile, writeFileWithBackup } from "../lib/filesystem.js";
import { asyncHandler, ok } from "../lib/http.js";

const writeTimestamps = new Map<string, number>();
const DEFAULT_VERSIONS_LIMIT = 50;
const MAX_VERSIONS_LIMIT = 200;

function assertAllowedName(name: string): void {
  if (!BOOTSTRAP_FILE_NAMES.has(name as (typeof BOOTSTRAP_FILES)[number]["name"])) {
    throw new HttpError("Bootstrap file is not in allowlist", 400);
  }
}

function getVersionLimit(rawLimit: unknown): number {
  if (rawLimit === undefined) {
    return DEFAULT_VERSIONS_LIMIT;
  }

  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_VERSIONS_LIMIT) {
    throw new HttpError(`limit must be an integer between 1 and ${MAX_VERSIONS_LIMIT}`, 400);
  }
  return limit;
}

function getVersionId(rawId: unknown, fieldName: string): number {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) {
    throw new HttpError(`${fieldName} must be a positive integer`, 400);
  }
  return id;
}

function readVersionOrThrow(name: string, id: number) {
  const version = getIdentityVersion(name, id);
  if (!version) {
    throw new HttpError("Version not found", 404);
  }
  return version;
}

function splitLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized) {
    return [];
  }

  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function buildUnifiedDiff(fromContent: string, toContent: string, name: string, fromId: number, toId: number): string {
  const fromLines = splitLines(fromContent);
  const toLines = splitLines(toContent);
  const lcs = Array.from({ length: fromLines.length + 1 }, () => Array<number>(toLines.length + 1).fill(0));

  for (let i = fromLines.length - 1; i >= 0; i -= 1) {
    for (let j = toLines.length - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        fromLines[i] === toLines[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const diffLines = [
    `--- ${name}@${fromId}`,
    `+++ ${name}@${toId}`,
    `@@ -1,${fromLines.length} +1,${toLines.length} @@`,
  ];

  let i = 0;
  let j = 0;
  while (i < fromLines.length && j < toLines.length) {
    if (fromLines[i] === toLines[j]) {
      diffLines.push(` ${fromLines[i]}`);
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      diffLines.push(`-${fromLines[i]}`);
      i += 1;
    } else {
      diffLines.push(`+${toLines[j]}`);
      j += 1;
    }
  }

  while (i < fromLines.length) {
    diffLines.push(`-${fromLines[i]}`);
    i += 1;
  }
  while (j < toLines.length) {
    diffLines.push(`+${toLines[j]}`);
    j += 1;
  }

  return diffLines.join("\n");
}

export const bootstrapRouter = Router();

bootstrapRouter.get(
  "/files",
  asyncHandler(async (_req, res) => {
    const versionCounts = listIdentityVersionCountsByFile();
    const files = await Promise.all(
      BOOTSTRAP_FILES.map(async (file) => {
        const targetPath = path.join(env.workspaceDir, file.name);
        const content = fs.existsSync(targetPath) ? await fs.promises.readFile(targetPath, "utf8") : "";
        return {
          name: file.name,
          path: targetPath,
          sizeChars: content.length,
          budgetMax: BOOTSTRAP_FILE_BUDGET_MAX,
          injectionOrder: file.injectionOrder,
          loadInSubagent: file.loadInSubagent,
          versionCount: versionCounts.get(file.name) ?? 0,
          specialInstruction: ("specialInstruction" in file ? file.specialInstruction : null) ?? null,
        };
      }),
    );

    const totalBudgetUsed = files.reduce((sum, file) => sum + file.sizeChars, 0);

    ok(res, {
      files,
      totalBudget: {
        used: totalBudgetUsed,
        max: BOOTSTRAP_BUDGET_MAX,
      },
    });
  }),
);

bootstrapRouter.get(
  "/file/:name/versions",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    ok(res, listIdentityVersions(name, getVersionLimit(req.query.limit)));
  }),
);

bootstrapRouter.get(
  "/file/:name/versions/:id",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    ok(res, readVersionOrThrow(name, getVersionId(req.params.id, "id")));
  }),
);

bootstrapRouter.get(
  "/file/:name/diff",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    const from = readVersionOrThrow(name, getVersionId(req.query.from, "from"));
    const to = readVersionOrThrow(name, getVersionId(req.query.to, "to"));

    ok(res, {
      from: {
        id: from.id,
        created_at: from.created_at,
        char_count: from.char_count,
      },
      to: {
        id: to.id,
        created_at: to.created_at,
        char_count: to.char_count,
      },
      diff: buildUnifiedDiff(from.content, to.content, name, from.id, to.id),
    });
  }),
);

bootstrapRouter.get(
  "/file/:name",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);
    ok(res, {
      name,
      content: await safeReadTextFile(name, env.workspaceDir),
    });
  }),
);

bootstrapRouter.put(
  "/file/:name",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    const content = String(req.body?.content ?? "");
    if (content.length > BOOTSTRAP_WRITE_LIMIT) {
      throw new HttpError(`Content exceeds ${BOOTSTRAP_WRITE_LIMIT} characters`, 400);
    }

    const lastWriteAt = writeTimestamps.get(name) ?? 0;
    if (Date.now() - lastWriteAt < BOOTSTRAP_WRITE_WINDOW_MS) {
      throw new HttpError("Write rate limit exceeded for this file", 429);
    }

    const targetPath = path.join(env.workspaceDir, name);
    if (fs.existsSync(targetPath)) {
      insertIdentityVersion(name, await safeReadTextFile(name, env.workspaceDir));
    }

    await writeFileWithBackup(name, env.workspaceDir, content);
    writeTimestamps.set(name, Date.now());

    ok(res, {
      name,
      sizeChars: content.length,
    });
  }),
);

bootstrapRouter.put(
  "/file/:name/versions/:id/label",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    const label = String(req.body?.label ?? "").trim();
    if (!updateIdentityVersionLabel(name, getVersionId(req.params.id, "id"), label || null)) {
      throw new HttpError("Version not found", 404);
    }

    ok(res, {
      id: getVersionId(req.params.id, "id"),
      file_name: name,
      label: label || null,
    });
  }),
);

bootstrapRouter.post(
  "/file/:name/restore/:id",
  asyncHandler(async (req, res) => {
    const name = String(req.params.name);
    assertAllowedName(name);

    const id = getVersionId(req.params.id, "id");
    const version = readVersionOrThrow(name, id);

    await writeFileWithBackup(name, env.workspaceDir, version.content);
    insertIdentityVersion(name, version.content, `Restored from version #${id}`);
    writeTimestamps.set(name, Date.now());

    ok(res, {
      name,
      content: version.content,
      sizeChars: version.char_count,
    });
  }),
);
