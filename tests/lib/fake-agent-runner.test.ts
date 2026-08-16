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
      signal: AbortSignal.timeout(5000),
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
      signal: AbortSignal.timeout(5000),
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
      signal: AbortSignal.timeout(5000),
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
      signal: AbortSignal.timeout(5000),
    });
    expect(await fs.readFile(path.join(root, meta.storyId, "world.md"), "utf8")).toBe(worldBefore);
    expect(await fs.readFile(path.join(root, meta.storyId, "player.md"), "utf8")).toBe(playerBefore);
    expect(await fs.readFile(path.join(root, meta.storyId, "logs", ".gitkeep"), "utf8")).toBe(logsBefore);
  });
});

describe("FakeAgentRunner init task (Issue 7)", () => {
  const INIT_SETTING = "深夜的边境酒馆，主角是一名逃亡的炼金术士，身边带着一只会说话的猫";

  async function runInit(storyId: string) {
    const runner = new FakeAgentRunner();
    return runner.runTurn({
      storyId,
      workspaceDir: resolveWorkspaceDir(storyId),
      playerInput: INIT_SETTING,
      task: "init",
      signal: AbortSignal.timeout(5000),
    });
  }

  it("writes initialized conceptual documents", async () => {
    const meta = await createStory();
    await runInit(meta.storyId);
    const dir = path.join(root, meta.storyId);
    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    const rules = await fs.readFile(path.join(dir, "rules.md"), "utf8");
    const actor = await fs.readFile(path.join(dir, "actors", "shopkeeper.md"), "utf8");
    // 覆盖占位内容
    expect(world).toContain("世界设定");
    expect(world).not.toContain("占位");
    expect(rules).not.toContain("占位");
    expect(actor).toContain("店主");
  });

  it("preserves user setting verbatim in player.md (canon)", async () => {
    const meta = await createStory();
    await runInit(meta.storyId);
    const player = await fs.readFile(
      path.join(root, meta.storyId, "player.md"),
      "utf8",
    );
    expect(player).toContain(INIT_SETTING);
    expect(player).not.toContain("占位");
  });

  it("writes opening protagonist view to turn/output.md and done marker", async () => {
    const meta = await createStory();
    const result = await runInit(meta.storyId);
    const dir = path.join(root, meta.storyId);
    expect(result.success).toBe(true);
    const output = await fs.readFile(path.join(dir, "turn", "output.md"), "utf8");
    expect(output).toContain("主角视窗");
    expect(output).not.toContain("占位");
    const done = JSON.parse(
      await fs.readFile(path.join(dir, "turn", "done.json"), "utf8"),
    );
    expect(done.status).toBe("success");
  });

  it("does not modify story.md or turns/history.jsonl", async () => {
    const meta = await createStory();
    const storyBefore = await fs.readFile(
      path.join(root, meta.storyId, "story.md"),
      "utf8",
    );
    await runInit(meta.storyId);
    expect(await fs.readFile(path.join(root, meta.storyId, "story.md"), "utf8")).toBe(storyBefore);
    const history = await fs.readFile(
      path.join(root, meta.storyId, "turns", "history.jsonl"),
      "utf8",
    );
    expect(history).toBe("");
  });
});
