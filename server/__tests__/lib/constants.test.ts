import { describe, expect, it } from "vitest";

import { BOOTSTRAP_FILES } from "../../lib/constants.js";

describe("bootstrap constants", () => {
  it("defines exactly eight bootstrap files", () => {
    expect(BOOTSTRAP_FILES).toHaveLength(8);
  });

  it("uses sequential injection order", () => {
    expect(BOOTSTRAP_FILES.map((file) => file.injectionOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("marks SOUL.md with a special instruction", () => {
    const soulFile = BOOTSTRAP_FILES.find((file) => file.name === "SOUL.md");
    expect(soulFile?.specialInstruction).toBe("System instruction: embody persona and tone");
  });

  it("marks the five subagent bootstrap files", () => {
    expect(BOOTSTRAP_FILES.filter((file) => file.loadInSubagent).map((file) => file.name)).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
    ]);
  });
});
