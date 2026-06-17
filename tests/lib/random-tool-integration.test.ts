import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { rollChoice, RANDOM_ROLLS_LOG } from "@/lib/random-tool";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import {
  createStory,
  readTurnDone,
  readTurnOutput,
  resolveWorkspaceDir,
} from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;

beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});

afterAll(() => resetWorkspaceRoot());

async function readRandomLogs(storyId: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(
    path.join(root, storyId, "logs", RANDOM_ROLLS_LOG),
    "utf8",
  );
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class RandomOutcomeRunner implements AgentRunner {
  constructor(private readonly rng: () => number) {}

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    req.signal.throwIfAborted();
    const roll = await rollChoice({
      storyId: req.storyId,
      workspaceDir: req.workspaceDir,
      rollId: "lockpick-outcome",
      candidates: [
        { id: "success", label: "撬锁成功", weight: 25 },
        { id: "fail", label: "撬锁失败", weight: 75 },
      ],
      rng: this.rng,
    });
    req.signal.throwIfAborted();

    const visibleConsequence =
      roll.selectedId === "success"
        ? "锁簧轻响，门缝向内打开。"
        : "铁丝折断，锁孔里传出刺耳的刮擦声。";

    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      [
        "# 主角视窗",
        "",
        `随机结果：${roll.selectedId}`,
        "",
        visibleConsequence,
        "",
      ].join("\n"),
    );
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({
        status: "success",
        completedAt: new Date().toISOString(),
      }),
    );
    return { success: true };
  }
}

class BrokenRandomLogRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const logsPath = path.join(req.workspaceDir, "logs");
    await fs.rm(logsPath, { recursive: true, force: true });
    await fs.writeFile(logsPath, "not a directory");

    await rollChoice({
      storyId: req.storyId,
      workspaceDir: req.workspaceDir,
      rollId: "log-write-failure",
      candidates: [{ id: "only", weight: 1 }],
      rng: () => 0.5,
    });

    await fs.writeFile(path.join(req.workspaceDir, "turn", "output.md"), "should not happen");
    await fs.writeFile(
      path.join(req.workspaceDir, "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

class RandomThenFailsRunner implements AgentRunner {
  observedRandomLogBeforeFailure = false;

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    await rollChoice({
      storyId: req.storyId,
      workspaceDir: req.workspaceDir,
      rollId: "post-roll-failure",
      candidates: [
        { id: "success", label: "成功", weight: 1 },
        { id: "fail", label: "失败", weight: 1 },
      ],
      rng: () => 0.2,
    });

    const raw = await fs.readFile(
      path.join(req.workspaceDir, "logs", RANDOM_ROLLS_LOG),
      "utf8",
    );
    this.observedRandomLogBeforeFailure = raw.includes("post-roll-failure");

    await fs.writeFile(path.join(req.workspaceDir, "turn", "output.md"), "should roll back");
    return { success: false, error: "post-roll failure" };
  }
}

describe("Random Tool + TurnOrchestrator integration", () => {
  it("binds a success roll to player-visible output and random log", async () => {
    const meta = await createStory({ title: "success roll" });
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 0.1));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).toContain("随机结果：success");
    expect(outcome.playerResponse).toContain("门缝向内打开");
    expect(outcome.playerResponse).toBe(await readTurnOutput(meta.storyId));
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "lockpick-outcome",
      selectedId: "success",
    });
  });

  it("binds a failure roll to player-visible output and random log", async () => {
    const meta = await createStory({ title: "failure roll" });
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 0.9));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).toContain("随机结果：fail");
    expect(outcome.playerResponse).toContain("铁丝折断");
    const logs = await readRandomLogs(meta.storyId);
    expect(logs[0]).toMatchObject({
      rollId: "lockpick-outcome",
      selectedId: "fail",
    });
  });

  it("invalid rng makes the turn fail and rollback without preserving random log", async () => {
    const meta = await createStory({ title: "invalid rng rollback" });
    const outputBefore = await readTurnOutput(meta.storyId);
    const orchestrator = new TurnOrchestrator(new RandomOutcomeRunner(() => 1));

    const outcome = await orchestrator.executeTurn(meta.storyId, "我试着撬锁");

    expect(outcome.success).toBe(false);
    expect(await readTurnOutput(meta.storyId)).toBe(outputBefore);
    expect(await readTurnDone(meta.storyId)).toBeNull();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG)),
    ).rejects.toThrow();
  });

  it("removes an appended random log when the same turn fails later", async () => {
    const meta = await createStory({ title: "post-roll failure rollback" });
    const outputBefore = await readTurnOutput(meta.storyId);
    const runner = new RandomThenFailsRunner();
    const orchestrator = new TurnOrchestrator(runner);

    const outcome = await orchestrator.executeTurn(meta.storyId, "随机后失败");

    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("post-roll failure");
    expect(runner.observedRandomLogBeforeFailure).toBe(true);
    expect(await readTurnOutput(meta.storyId)).toBe(outputBefore);
    expect(await readTurnDone(meta.storyId)).toBeNull();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG)),
    ).rejects.toThrow();
  });

  it("random log write failure rolls back and runner does not commit output or done", async () => {
    const meta = await createStory({ title: "log failure rollback" });
    const outputBefore = await readTurnOutput(meta.storyId);
    const orchestrator = new TurnOrchestrator(new BrokenRandomLogRunner());

    const outcome = await orchestrator.executeTurn(meta.storyId, "触发日志失败");

    expect(outcome.success).toBe(false);
    expect(await readTurnOutput(meta.storyId)).toBe(outputBefore);
    expect(await readTurnDone(meta.storyId)).toBeNull();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", ".gitkeep")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", RANDOM_ROLLS_LOG)),
    ).rejects.toThrow();
  });
});
