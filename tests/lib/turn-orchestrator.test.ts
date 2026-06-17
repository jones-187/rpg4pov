import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnOrchestrator, TurnBusyError } from "@/lib/turn-orchestrator";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { createStory, readTurnDone, readTurnOutput, resolveSnapshotsRoot } from "@/lib/workspace";
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

/** 超时模拟 runner：永不返回，直到 signal abort。 */
class HangingRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    return await new Promise<TurnResult>((_, reject) => {
      req.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
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

  // --- Issue 4 新增测试 ---

  it("failed turn restores workspace to pre-turn state (Issue 4 rollback)", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);
    // 手动写入上一回合的 done.json（快照应捕获它）
    const donePath = path.join(wsDir, "turn", "done.json");
    const prevDone = JSON.stringify({
      status: "success",
      completedAt: "2000-01-01T00:00:00.000Z",
    });
    await fs.writeFile(donePath, prevDone);

    // runner 在执行期间写半成品文件，但不写 done.json → 失败
    class HalfBakedRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const dir = req.workspaceDir;
        await fs.writeFile(path.join(dir, "actors", "half-baked-npc.md"), "半成品");
        return { success: false, error: "half-baked" };
      }
    }

    const orchestrator = new TurnOrchestrator(new HalfBakedRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "测试");
    expect(outcome.success).toBe(false);
    // 关键：回滚后 done.json 恢复为快照态（上回合的成功标记），不是被清理
    const restoredDone = await fs.readFile(donePath, "utf8");
    expect(restoredDone).toBe(prevDone);
    // runner 新增的半成品文件被清除
    await expect(fs.access(path.join(wsDir, "actors", "half-baked-npc.md"))).rejects.toThrow();
  });

  it("timeout: hanging runner is aborted, turn fails with timeout reason", async () => {
    const meta = await createStory();
    // 用极短超时，避免测试等待 60s
    const prev = process.env.TURN_TIMEOUT_MS;
    process.env.TURN_TIMEOUT_MS = "200";
    try {
      const orchestrator = new TurnOrchestrator(new HangingRunner());
      const outcome = await orchestrator.executeTurn(meta.storyId, "等待");
      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.TURN_TIMEOUT_MS;
      else process.env.TURN_TIMEOUT_MS = prev;
    }
  });

  it("rollback removes files the runner wrote before failing", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);
    const worldBefore = await fs.readFile(path.join(wsDir, "world.md"), "utf8");

    // runner 写了半成品 world.md + 新文件，但不写 done.json → 失败
    class HalfBakedRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const dir = req.workspaceDir;
        await fs.writeFile(path.join(dir, "world.md"), "被污染的世界");
        await fs.writeFile(path.join(dir, "actors", "ghost.md"), "幽灵 NPC");
        // 故意不写 done.json → 触发失败
        return { success: false, error: "half-baked" };
      }
    }
    const orchestrator = new TurnOrchestrator(new HalfBakedRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);

    // 回滚后 world.md 回到快照态
    const worldAfter = await fs.readFile(path.join(wsDir, "world.md"), "utf8");
    expect(worldAfter).toBe(worldBefore);
    // 幽灵文件被清除
    await expect(fs.access(path.join(wsDir, "actors", "ghost.md"))).rejects.toThrow();
  });

  it("second concurrent turn for same storyId throws TurnBusyError", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new HangingRunner());
    // 用短超时
    const prev = process.env.TURN_TIMEOUT_MS;
    process.env.TURN_TIMEOUT_MS = "2000";
    try {
      // 第一个回合挂起（HangingRunner 不返回），但不 await
      const p1 = orchestrator.executeTurn(meta.storyId, "第一回合");
      // 让事件循环推进，让 p1 真正拿到锁
      await new Promise((r) => setTimeout(r, 10));
      // 第二个回合应被锁拒绝
      await expect(orchestrator.executeTurn(meta.storyId, "并发")).rejects.toThrow(
        TurnBusyError,
      );
      // 等第一个回合超时结束（释放锁）——它返回失败 outcome，不 reject
      const outcome1 = await p1;
      expect(outcome1.success).toBe(false);
      expect(outcome1.error).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.TURN_TIMEOUT_MS;
      else process.env.TURN_TIMEOUT_MS = prev;
    }
  });

  it("successful turn deletes its snapshot", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "成功");
    // 快照目录应不存在（成功后删除）
    const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
    await expect(fs.access(snapDir)).rejects.toThrow();
  });
});
