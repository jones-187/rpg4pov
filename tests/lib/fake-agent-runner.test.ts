import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

describe("FakeAgentRunner", () => {
  it("writes turn/output.md containing the player input", async () => {
    const meta = await createStory({ title: "fake agent 测试" });
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
    });
    const output = await fs.readFile(
      path.join(root, meta.storyId, "turn", "output.md"),
      "utf8",
    );
    expect(output).toContain("推开木门");
    expect(output).toContain("主角视窗");
  });

  it("writes turn/done.json with status=success and ISO completedAt", async () => {
    const meta = await createStory();
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "观察四周",
    });
    const raw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "done.json"),
      "utf8",
    );
    const done = JSON.parse(raw);
    expect(done.status).toBe("success");
    expect(() => new Date(done.completedAt).toISOString()).not.toThrow();
  });

  it("returns { success: true }", async () => {
    const meta = await createStory();
    const runner = new FakeAgentRunner();
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "试探",
    });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("does not touch logs/ or world.md or player.md", async () => {
    const meta = await createStory();
    const worldBefore = await fs.readFile(
      path.join(root, meta.storyId, "world.md"),
      "utf8",
    );
    const playerBefore = await fs.readFile(
      path.join(root, meta.storyId, "player.md"),
      "utf8",
    );
    const logsBefore = await fs.readFile(
      path.join(root, meta.storyId, "logs", ".gitkeep"),
      "utf8",
    );
    const runner = new FakeAgentRunner();
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "不动",
    });
    expect(await fs.readFile(path.join(root, meta.storyId, "world.md"), "utf8")).toBe(worldBefore);
    expect(await fs.readFile(path.join(root, meta.storyId, "player.md"), "utf8")).toBe(playerBefore);
    expect(await fs.readFile(path.join(root, meta.storyId, "logs", ".gitkeep"), "utf8")).toBe(logsBefore);
  });
});
