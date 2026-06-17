import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnError } from "@/lib/turn-error-log";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("appendTurnError", () => {
  it("writes a JSONL line to logs/turn-errors.log", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "runner crashed", input: "推开木门" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.reason).toBe("runner crashed");
    expect(entry.storyId).toBe(meta.storyId);
    expect(entry.input).toBe("推开木门");
    expect(() => new Date(entry.at).toISOString()).not.toThrow();
  });

  it("appends multiple errors as separate JSONL lines", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "first" });
    await appendTurnError(meta.storyId, { reason: "second" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const lines = raw.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).reason).toBe("first");
    expect(JSON.parse(lines[1]).reason).toBe("second");
  });

  it("input field is optional", async () => {
    const meta = await createStory();
    await appendTurnError(meta.storyId, { reason: "no input ctx" });
    const raw = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    const entry = JSON.parse(raw.trim());
    expect(entry.reason).toBe("no input ctx");
    expect(entry.input).toBeUndefined();
  });

  it("does not throw on append failure (best-effort) — e.g. invalid storyId", async () => {
    // invalid storyId → 路径解析会抛，但 appendTurnError 应吞掉（best-effort）
    await expect(
      appendTurnError("not-a-uuid", { reason: "x" }),
    ).resolves.toBeUndefined();
  });
});
