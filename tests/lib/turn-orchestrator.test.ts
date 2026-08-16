import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TurnOrchestrator, TurnBusyError } from "@/lib/turn-orchestrator";
import type { AgentRunner, TurnRequest, TurnResult } from "@/lib/agent-runner";
import { FakeAgentRunner } from "@/lib/fake-agent-runner";
import { createStory, getStory, readTurnDone, readTurnOutput, resolveSnapshotsRoot, resolveWorkspaceDir } from "@/lib/workspace";
import { readWorkspaceUnsafeMarker } from "@/lib/turn-snapshot";
import { readTurnHistory, type TurnHistoryEntry } from "@/lib/turn-history";
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

/**
 * 受控 runner：通过 started resolve 让测试方知道 runner 已拿到执行权。
 * runner 在 started resolve 后挂起，直到 signal abort。
 */
class ControlledRunner implements AgentRunner {
  readonly started: Promise<void>;
  private resolveStarted!: () => void;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.resolveStarted();
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
    // 用极短超时，避免测试等待
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

  it("timeout: error log records reason='timeout' with durationMs detail", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);
    const logsDir = path.join(wsDir, "logs");
    const prev = process.env.TURN_TIMEOUT_MS;
    process.env.TURN_TIMEOUT_MS = "200";
    try {
      const orchestrator = new TurnOrchestrator(new HangingRunner());
      const outcome = await orchestrator.executeTurn(meta.storyId, "等待超时");
      expect(outcome.success).toBe(false);
      expect(outcome.error).toBe("timeout");

      // 验证 turn-errors.log 记录了 timeout 原因和 duration 信息
      const logPath = path.join(logsDir, "turn-errors.log");
      const logRaw = await fs.readFile(logPath, "utf8");
      const entry = JSON.parse(logRaw.trim());
      expect(entry.reason).toBe("timeout");
      expect(entry.detail).toContain("timeout after");
      expect(entry.detail).toContain("ms");
      expect(entry.input).toBe("等待超时");
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
    const controlled = new ControlledRunner();
    const orchestrator = new TurnOrchestrator(controlled);
    // 用较长超时确保 controlled runner 不会被提前 abort
    const prev = process.env.TURN_TIMEOUT_MS;
    process.env.TURN_TIMEOUT_MS = "10000";
    try {
      // 第一个回合挂起（ControlledRunner），等它真正拿到执行权
      const p1 = orchestrator.executeTurn(meta.storyId, "第一回合");
      await controlled.started; // 确定runner已进入runTurn
      // 第二个回合应被锁拒绝
      await expect(orchestrator.executeTurn(meta.storyId, "并发")).rejects.toThrow(
        TurnBusyError,
      );
      // p1 会超时（10s），但我们直接等它返回即可
      const outcome1 = await p1;
      expect(outcome1.success).toBe(false);
      expect(outcome1.error).toBe("timeout");
    } finally {
      if (prev === undefined) delete process.env.TURN_TIMEOUT_MS;
      else process.env.TURN_TIMEOUT_MS = prev;
    }
  }, 15000);

  it("rollback failed: writes unsafe marker and error log when restoreSnapshot fails", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);
    const logsDir = path.join(wsDir, "logs");

    // 让 NoopRunner 触发失败（不写 done.json）
    // 但在 runner 执行前破坏 snapshot 目录，使 restoreSnapshot 失败
    // 做法：用 vi.spy 拦截 restoreSnapshot 让它抛错
    const snapshotModule = await import("@/lib/turn-snapshot");
    const restoreSpy = vi.spyOn(snapshotModule, "restoreSnapshot").mockRejectedValue(
      new Error("disk full"),
    );

    try {
      const orchestrator = new TurnOrchestrator(new NoopRunner());
      const outcome = await orchestrator.executeTurn(meta.storyId, "灾难");
      expect(outcome.success).toBe(false);
      // 用户响应仍返回原始失败原因（不是 rollback failed）
      expect(outcome.error).toBe("did nothing");

      // unsafe marker 被写入
      const marker = await readWorkspaceUnsafeMarker(meta.storyId);
      expect(marker).not.toBeNull();
      expect(marker!.reason).toContain("rollback failed");
      expect(marker!.reason).toContain("disk full");

      // turn error log 中有 rollback failed 记录
      const logPath = path.join(logsDir, "turn-errors.log");
      const logRaw = await fs.readFile(logPath, "utf8");
      const lines = logRaw.trim().split("\n");
      const rollbackLine = lines.find((l) => l.includes("rollback failed"));
      expect(rollbackLine).toBeDefined();
      const entry = JSON.parse(rollbackLine!);
      expect(entry.reason).toContain("rollback failed");
      expect(entry.reason).toContain("disk full");

      // snapshot 目录被保留（灾难路径下是人工恢复/排查的最后依据）
      const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
      await expect(fs.access(snapDir)).resolves.toBeUndefined();
    } finally {
      restoreSpy.mockRestore();
    }
  });

  it("workspace unsafe marker blocks subsequent turns", async () => {
    const meta = await createStory();
    // 手动写入 unsafe marker
    const { markWorkspaceUnsafe } = await import("@/lib/turn-snapshot");
    await markWorkspaceUnsafe(meta.storyId, "previous rollback disaster");

    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "尝试继续");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("workspace unsafe");
    expect(outcome.error).toContain("previous rollback disaster");
  });

  it("successful turn deletes its snapshot", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "成功");
    // 快照目录应不存在（成功后删除）
    const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
    await expect(fs.access(snapDir)).rejects.toThrow();
  });

  // --- Issue 6.5 新增测试 ---

  it("successful turn appends entry to turns/history.jsonl (Issue 6.5)", async () => {
    const meta = await createStory({ title: "history append 测试" });
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "推开木门");

    expect(outcome.success).toBe(true);

    // 验证 history 被追加
    const history = await readTurnHistory(meta.storyId);
    expect(history).not.toBeNull();
    expect(history!.length).toBe(1);

    const entry = history![0];
    expect(entry.input).toBe("推开木门");
    expect(entry.output).toBe(outcome.playerResponse);
    expect(entry.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("failed turn does not append to history (Issue 6.5)", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new NoopRunner()); // 不写 done.json
    const outcome = await orchestrator.executeTurn(meta.storyId, "失败测试");

    expect(outcome.success).toBe(false);

    const history = await readTurnHistory(meta.storyId);
    expect(history).toEqual([]);
  });

  it("history append failure causes turn to fail and rollback (Issue 6.5)", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);

    // 记录回合前状态
    const outputBefore = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    const doneBefore = await fs.readFile(path.join(wsDir, "turn", "done.json"), "utf8").catch(() => null);

    // 让 FakeAgentRunner 成功执行，但 appendTurnHistory 失败
    const historyModule = await import("@/lib/turn-history");
    const appendSpy = vi.spyOn(historyModule, "appendTurnHistory").mockRejectedValue(
      new Error("disk full"),
    );

    try {
      const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
      const outcome = await orchestrator.executeTurn(meta.storyId, "灾难测试");

      expect(outcome.success).toBe(false);
      expect(outcome.error).toBeDefined();

      // history 未被写入（因为 append 失败）
      const history = await readTurnHistory(meta.storyId);
      expect(history).toEqual([]);

      // Issue 6.5 反馈 3：验证 rollback 真的发生
      // turn/output.md 恢复到回合前状态
      const outputAfter = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
      expect(outputAfter).toBe(outputBefore);

      // done.json 恢复到回合前状态（或不存在）
      const doneAfter = await fs.readFile(path.join(wsDir, "turn", "done.json"), "utf8").catch(() => null);
      expect(doneAfter).toBe(doneBefore);
    } finally {
      appendSpy.mockRestore();
    }
  });

  it("successful turn returns committed TurnHistoryEntry (Issue 6.5)", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "测试返回");

    expect(outcome.success).toBe(true);
    expect(outcome.turn).toBeDefined();
    expect(outcome.turn!.input).toBe("测试返回");
    expect(outcome.turn!.output).toBe(outcome.playerResponse);
    expect(outcome.turn!.turnId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  // --- Issue 7 新增测试 ---

  it("regular turn (no task) does not mark story initialized (Issue 7 回归)", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, "普通回合");
    const story = await getStory(meta.storyId);
    expect(story?.initialized).toBe(false);
  });

  it("init task passes task to runner via TurnRequest", async () => {
    const meta = await createStory();
    const seen: Array<string | undefined> = [];
    class RecordingRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        seen.push(req.task);
        const turnDir = path.join(req.workspaceDir, "turn");
        await fs.writeFile(path.join(turnDir, "output.md"), "# 主角视窗\n\n开场");
        await fs.writeFile(
          path.join(turnDir, "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }
    const orchestrator = new TurnOrchestrator(new RecordingRunner());
    await orchestrator.executeTurn(meta.storyId, "设定", { task: "init" });
    expect(seen).toEqual(["init"]);
  });
});

describe("TurnOrchestrator init task (Issue 7)", () => {
  const SETTING = "雨夜旅店，主角是逃亡的炼金术士";

  it("init success: appends opening to history and marks story initialized", async () => {
    const meta = await createStory({ title: "初始化成功" });
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, SETTING, { task: "init" });

    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).toContain("主角视窗");

    // 开场作为第一条 history entry（input=设定，output=开场视窗）
    const history = await readTurnHistory(meta.storyId);
    expect(history).not.toBeNull();
    expect(history!.length).toBe(1);
    expect(history![0].input).toBe(SETTING);
    expect(history![0].output).toBe(outcome.playerResponse);

    // story.md 被标记为已初始化
    const story = await getStory(meta.storyId);
    expect(story?.initialized).toBe(true);

    // 快照被清理
    const snapDir = path.join(resolveSnapshotsRoot(), meta.storyId);
    await expect(fs.access(snapDir)).rejects.toThrow();
  });

  it("init failure: no history entry, story stays uninitialized", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new NoopRunner()); // 不写 done.json
    const outcome = await orchestrator.executeTurn(meta.storyId, SETTING, { task: "init" });

    expect(outcome.success).toBe(false);
    const history = await readTurnHistory(meta.storyId);
    expect(history).toEqual([]);
    const story = await getStory(meta.storyId);
    expect(story?.initialized).toBe(false);
  });

  it("markStoryInitialized failure: init fails and rolls back (no entry, not initialized, placeholders restored)", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);

    const workspaceModule = await import("@/lib/workspace");
    const markSpy = vi.spyOn(workspaceModule, "markStoryInitialized").mockRejectedValue(
      new Error("disk full"),
    );

    try {
      const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
      const outcome = await orchestrator.executeTurn(meta.storyId, SETTING, { task: "init" });

      expect(outcome.success).toBe(false);
      expect(outcome.error).toContain("mark initialized failed");

      // 无 history entry、未标记初始化
      const history = await readTurnHistory(meta.storyId);
      expect(history).toEqual([]);
      const story = await getStory(meta.storyId);
      expect(story?.initialized).toBe(false);

      // workspace 回滚到占位骨架（fake init 写入的内容被撤销）
      const world = await fs.readFile(path.join(wsDir, "world.md"), "utf8");
      expect(world).toContain("占位");
    } finally {
      markSpy.mockRestore();
    }
  });

  it("init with placeholder conceptual docs fails validation and rolls back (Seam 8)", async () => {
    const meta = await createStory();
    const wsDir = path.join(root, meta.storyId);

    // runner 只写 output + done，不填概念文档（world/player/rules 仍是占位）
    class LazyInitRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const turnDir = path.join(req.workspaceDir, "turn");
        await fs.writeFile(path.join(turnDir, "output.md"), "# 主角视窗\n\n开场。");
        await fs.writeFile(
          path.join(turnDir, "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }

    const orchestrator = new TurnOrchestrator(new LazyInitRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, SETTING, { task: "init" });

    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("init validation failed");

    // 无 entry、未标记、output 回滚回占位
    const history = await readTurnHistory(meta.storyId);
    expect(history).toEqual([]);
    expect((await getStory(meta.storyId))?.initialized).toBe(false);
    const output = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(output).toContain("占位");
  });

  it("init on already-initialized story is rejected under lock without rerunning", async () => {
    const meta = await createStory();
    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    await orchestrator.executeTurn(meta.storyId, SETTING, { task: "init" });
    const historyAfterFirst = await readTurnHistory(meta.storyId);
    expect(historyAfterFirst).toHaveLength(1);

    // 模拟竞态窗口：route 预检查已过，但锁内发现已初始化 → 拒绝，不追加第二条开场
    const outcome = await orchestrator.executeTurn(meta.storyId, "重复初始化", { task: "init" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("story already initialized");
    const history = await readTurnHistory(meta.storyId);
    expect(history).toHaveLength(1);
    expect(history![0].input).toBe(SETTING);
  });

  it("runner writing done.json but not output.md is caught by placeholder check (审查修复)", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);

    class DoneOnlyRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        await fs.writeFile(
          path.join(req.workspaceDir, "turn", "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }

    const orchestrator = new TurnOrchestrator(new DoneOnlyRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "测试");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toBe("output missing or empty");
  });
});

// --- Issue 9：主角视窗输出校验（格式明显不合规 → 失败并回滚） ---

/** 写合规 output（首行标题）+ done.json 的基线 runner，content 可注入 */
class CompliantOutputRunner implements AgentRunner {
  constructor(private readonly body: string) {}
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(turnDir + path.sep + "output.md", `# 主角视窗\n\n${this.body}`);
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

describe("TurnOrchestrator output validation (Issue 9)", () => {
  it("output without 主角视窗 heading fails and rolls back", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);
    const wsDir = path.join(root, meta.storyId);

    class NoHeadingRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const turnDir = path.join(req.workspaceDir, "turn");
        await fs.writeFile(path.join(turnDir, "output.md"), "夜色深沉，没有标题。");
        await fs.writeFile(
          path.join(turnDir, "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }

    const orchestrator = new TurnOrchestrator(new NoHeadingRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("output format invalid");

    // 回滚：output.md 恢复占位，无 history entry
    const output = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(output).toContain("占位");
    const history = await readTurnHistory(meta.storyId);
    expect(history).toEqual([]);
  });

  it("output that dumps JSON as narrative fails", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);

    const orchestrator = new TurnOrchestrator(
      new CompliantOutputRunner('{"result":"ok","stdout":"..."}'),
    );
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("JSON");
  });

  it("runaway oversized output fails", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);

    const { MAX_TURN_OUTPUT_CHARS } = await import("@/lib/turn-output");
    const orchestrator = new TurnOrchestrator(
      new CompliantOutputRunner("雨".repeat(MAX_TURN_OUTPUT_CHARS)),
    );
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("exceeds");
  });

  it("output containing a random-rolls.jsonl line verbatim fails (内部日志外泄)", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);
    const rollLine = JSON.stringify({
      at: "2026-08-16T00:00:00.000Z",
      storyId: meta.storyId,
      rollId: "perception-check",
      type: "roll-choice",
      candidates: [{ id: "success", weight: 1 }],
      selectedId: "success",
      randomSource: "crypto",
      sample: 0.5,
    });
    // runner 在回合内调用随机工具（快照后写入），并把结果行逐字抄进 output
    class RollingLeakRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        await fs.writeFile(
          path.join(req.workspaceDir, "logs", "random-rolls.jsonl"),
          rollLine + "\n",
        );
        const turnDir = path.join(req.workspaceDir, "turn");
        await fs.writeFile(turnDir + path.sep + "output.md", `# 主角视窗\n\n${rollLine}\n\n你环顾四周。`);
        await fs.writeFile(
          path.join(turnDir, "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }

    const orchestrator = new TurnOrchestrator(new RollingLeakRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("random log");
    // 回滚连本回合的 random log 一并撤销（快照在 roll 写入之前）
    await expect(
      fs.access(path.join(root, meta.storyId, "logs", "random-rolls.jsonl")),
    ).rejects.toThrow();
  });

  it("random rolls present but not copied into output → turn succeeds (无 false positive)", async () => {
    const meta = await createStory();
    await (await import("@/lib/workspace")).markStoryInitialized(meta.storyId);
    const rollLine = JSON.stringify({ rollId: "luck", selectedId: "fail", sample: 0.9 });
    await fs.writeFile(path.join(root, meta.storyId, "logs", "random-rolls.jsonl"), rollLine + "\n");

    const orchestrator = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "试探");
    expect(outcome.success).toBe(true);
    expect(outcome.playerResponse).not.toContain("luck");
  });

  it("init task opening output is subject to the same heading contract", async () => {
    const meta = await createStory();

    class NoHeadingInitRunner implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const dir = req.workspaceDir;
        // 概念文档填实（绕过 init 校验），但 output 无标题 → 应被格式校验拦下
        await fs.writeFile(path.join(dir, "world.md"), "# 世界\n\n真实设定内容。");
        await fs.writeFile(path.join(dir, "player.md"), "# 主角\n\n真实主角卡。");
        await fs.writeFile(path.join(dir, "rules.md"), "# 规则\n\n真实规则。");
        await fs.writeFile(path.join(dir, "actors", "npc.md"), "# NPC\n\n真实 NPC。");
        await fs.writeFile(path.join(dir, "turn", "output.md"), "开场：雨夜旅店。");
        await fs.writeFile(
          path.join(dir, "turn", "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    }

    const orchestrator = new TurnOrchestrator(new NoHeadingInitRunner());
    const outcome = await orchestrator.executeTurn(meta.storyId, "设定", { task: "init" });
    expect(outcome.success).toBe(false);
    expect(outcome.error).toContain("output format invalid");
    expect((await getStory(meta.storyId))?.initialized).toBe(false);
  });
});

// --- Issue 10 / 12：Turn Interaction 与隔离扩展 ---

/** 写合法 interaction.json 的 runner */
class InteractionRunner implements AgentRunner {
  constructor(private interaction: unknown) {}
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      "# 主角视窗\n\n店主放下了手里的杯子。\n",
    );
    await fs.writeFile(
      path.join(turnDir, "interaction.json"),
      JSON.stringify(this.interaction),
    );
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

/** 把 interaction.json 原文逐字抄进 output 的 runner（Issue 12 外泄场景） */
class InteractionLeakRunner implements AgentRunner {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const turnDir = path.join(req.workspaceDir, "turn");
    const interaction = JSON.stringify({
      mode: "decision",
      suggestions: ["开口", "沉默"],
    });
    await fs.writeFile(
      path.join(turnDir, "output.md"),
      `# 主角视窗\n\n${interaction}\n`,
    );
    await fs.writeFile(path.join(turnDir, "interaction.json"), interaction);
    await fs.writeFile(
      path.join(turnDir, "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    return { success: true };
  }
}

describe("TurnOrchestrator interaction state (Issue 10)", () => {
  it("returns sanitized interaction on success", async () => {
    const story = await createStory();
    const orch = new TurnOrchestrator(
      new InteractionRunner({
        mode: "decision",
        suggestions: ["开口", "沉默"],
        hiddenIntent: "internal",
      }),
    );
    const outcome = await orch.executeTurn(story.storyId, "看向店主");
    expect(outcome.success).toBe(true);
    expect(outcome.interaction).toEqual({ mode: "decision", suggestions: ["开口", "沉默"] });
  });

  it("degrades to default interaction when runner writes nothing", async () => {
    const story = await createStory();
    const bare = new (class implements AgentRunner {
      async runTurn(req: TurnRequest): Promise<TurnResult> {
        const turnDir = path.join(req.workspaceDir, "turn");
        await fs.writeFile(turnDir + "/output.md", "# 主角视窗\n\n他抬头看你。\n");
        await fs.writeFile(
          turnDir + "/done.json",
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        return { success: true };
      }
    })();
    const outcome = await new TurnOrchestrator(bare).executeTurn(story.storyId, "x");
    expect(outcome.success).toBe(true);
    expect(outcome.interaction).toEqual({ mode: "continue", suggestions: [] });
  });

  it("continue command writes system directive to input.md and fixed label to history", async () => {
    const story = await createStory();
    const orch = new TurnOrchestrator(new FakeAgentRunner());
    const outcome = await orch.executeTurn(story.storyId, "", {
      systemCommand: "continue",
    });
    expect(outcome.success).toBe(true);
    expect(outcome.turn?.input).toBe("（继续）");
    const inputMd = await fs.readFile(
      path.join(resolveWorkspaceDir(story.storyId), "turn", "input.md"),
      "utf8",
    );
    expect(inputMd).toContain("【系统指令·继续】");
    const history = await readTurnHistory(story.storyId);
    expect(history).not.toBeNull();
    expect(history![history!.length - 1].input).toBe("（继续）");
  });

  it("interaction.json leak into output fails and rolls back (Issue 12)", async () => {
    const story = await createStory();
    const orch = new TurnOrchestrator(new InteractionLeakRunner());
    const outcome = await orch.executeTurn(story.storyId, "测试");
    expect(outcome.success).toBe(false);
    const history = await readTurnHistory(story.storyId);
    expect(history).toEqual([]);
    // 回滚后 output 恢复为占位原文（不是 runner 写入的外泄内容）
    const restored = await readTurnOutput(story.storyId);
    expect(restored).not.toContain("suggestions");
    expect(await readTurnDone(story.storyId)).toBe(null);
  });
});
