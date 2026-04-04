import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { COMMAND_TIMEOUT_MS } from "./constants.js";

const execFileAsync = promisify(execFile);

export async function runCommand(
  file: string,
  args: string[] = [],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(file, args, {
    cwd,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 4,
    env: process.env,
  });
}
