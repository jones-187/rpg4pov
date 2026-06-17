import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnOrchestrator } from "@/lib/turn-orchestrator";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { createStory, readTurnDone, readTurnOutput } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});
afterAll(() => resetWorkspaceRoot());

// --- 测试用 runner ---

/** 抛异常的 runner */
class CrashingRunner implements AgentRunner {
  async runTurn(): Promise<TurnResult> {
    throw new Error("boom");
  }
}

/** 什么都不做的 runner（不写 done.json） */
class NoopRunner implements AgentRunner {
  async runTurn(): Promise<TurnResult> {
    return { success: false, error: "did nothing" };
  }
}

/** 写 done.json 但 output.md 为空的 runner */
class EmptyOutputRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(path.join(turnDir, "output.md"), "");
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

// --- 测试 ---

describe("TurnOrchestrator", () => {
  it("success: FakeAgentRunner → returns playerResponse from output.md", async () => {
    const meta = await createStory({ title: "orchestrator 成功" });
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "推开木门");
    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).not.toBeNull();
    expect(outcome.playerResponse).toContain("推开木门");
    // 返回内容必须等于 turn/output.md 落盘内容
    expect(outcome.playerResponse).toBe(await readTurnOutput(meta.storyId));
  });

  it("success: done.json exists with status=success after turn", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "观察");
    const done = await readTurnDone(meta.storyId);
    expect(done).not.toBeNull();
    expect(done!.status).toBe("success");
  });

  it("runner crash: returns failure, does not throw", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new CrashingRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
    expect(outcome.error).toBeDefined();
  });

  it("missing done.json: returns failure", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new NoopRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "等待");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
  });

  it("empty output.md: returns failure even if done.json exists", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new EmptyOutputRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "沉默");
    expect(outcome.success).toBe(false);
    expect(outcome.playerResponse).toBeNull();
    // 锁住失败原因，供 Issue 4 诊断日志与未来失败码分类使用
    expect(outcome.error).toBe("output missing or empty");
  });

  it("clears old done.json before calling runner", async () => {
    const meta = await createStory();
    // 手动写入旧 done.json
    const donePath = path.join(root, meta.storyId, "turn", "done.json");
    await fs.writeFile(
      donePath,
      JSON.stringify({ status: "success", completedAt: "2000-01-01T00:00:00.000Z" }),
    );
    // 用 NoopRunner（不写 done.json），验证旧 done.json 被清理
    const orchestrator = new TurnOrchestrator(new NoopRunner());
    await orchestrator.executeTurn(meta.storyId, "测试");
    await expect(fs.access(donePath)).rejects.toThrow();
  });

  it("writes player input to turn/input.md before calling runner", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "走向酒馆");
    const inputRaw = await fs.readFile(
      path.join(root, meta.storyId, "turn", "input.md"),
      "utf8",
    );
    expect(inputRaw).toContain("走向酒馆");
  });
});
