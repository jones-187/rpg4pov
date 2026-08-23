import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeCodeRunner } from "@/lib/claude-code-runner";
import type { SpawnFn, SpawnOpts, SpawnResult } from "@/lib/claude-code-runner";
import { createStory, resolveWorkspaceDir, resolveWorkspaceRoot } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

let root: string;
beforeEach(async () => {
  root = await useTempWorkspaceRoot();
});
afterEach(() => resetWorkspaceRoot());

/** 构造 mock spawnFn，记录调用参数并返回预设结果 */
type CallRecord = { cmd: string; args: string[]; opts: SpawnOpts };
function makeMockSpawn(result: SpawnResult): { spawn: SpawnFn; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const spawn: SpawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return Promise.resolve(result);
  };
  return { spawn, calls };
}

describe("ClaudeCodeRunner", () => {
  it("显式把 Claude CLI 模型硬锁为 qwen-fp8", async () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "qwen-fp8";
    try {
      const meta = await createStory();
      const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
      const runner = new ClaudeCodeRunner({ spawnFn: spawn });
      await runner.runTurn({
        storyId: meta.storyId,
        workspaceDir: resolveWorkspaceDir(meta.storyId),
        playerInput: "测试",
        signal: AbortSignal.timeout(5000),
      });
      const modelIndex = calls[0].args.indexOf("--model");
      expect(calls[0].args[modelIndex + 1]).toBe("qwen-fp8");
      expect(calls[0].opts.env?.ANTHROPIC_MODEL).toBe("qwen-fp8");
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = saved;
    }
  });

  it("拒绝为 Claude CLI 配置其他模型", async () => {
    const saved = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "another-model";
    try {
      const meta = await createStory();
      const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
      const runner = new ClaudeCodeRunner({ spawnFn: spawn });
      await expect(
        runner.runTurn({
          storyId: meta.storyId,
          workspaceDir: resolveWorkspaceDir(meta.storyId),
          playerInput: "测试",
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toThrow(/requires qwen-fp8/);
      expect(calls).toHaveLength(0);
    } finally {
      if (saved === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = saved;
    }
  });

  it("调用 claude -p --output-format json，cwd=workspaceDir", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].cmd).toBe("claude");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].args).toContain("--output-format");
    expect(calls[0].args).toContain("json");
    expect(calls[0].opts.cwd).toBe(resolveWorkspaceDir(meta.storyId));
  });

  it("task 未设置或 turn 时使用回合 prompt（Issue 7 回归）", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].opts.stdinData).toContain("回合执行 agent");
    expect(calls[0].opts.stdinData).not.toContain("初始化 agent");
  });

  it("task=init 时 stdinData 为初始化 prompt（含设定与 canon 指令）", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "深夜酒馆，主角是逃亡炼金术士",
      task: "init",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].opts.stdinData).toContain("初始化 agent");
    expect(calls[0].opts.stdinData).toContain("深夜酒馆，主角是逃亡炼金术士");
    expect(calls[0].opts.stdinData).toContain("canon");
    expect(calls[0].opts.stdinData).not.toContain("回合执行 agent");
  });

  it("注入单参数 promptTemplate 仍兼容（task 参数被忽略）", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({
      spawnFn: spawn,
      promptTemplate: (input) => `CUSTOM:${input}`,
    });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "测试输入",
      task: "init",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].opts.stdinData).toBe("CUSTOM:测试输入");
  });

  it("env 白名单传递，不含全量 process.env，含 ANTHROPIC_API_KEY/PATH/HOME/NODE_ENV/TMPDIR/USE_BUILTIN_RIPGREP", async () => {
    const meta = await createStory();
    // 测试设置的 env 必须在 finally 中清理，避免断言失败时泄漏到后续测试
    process.env.ANTHROPIC_API_KEY = "sk-test-xxx";
    // 白名单外的 key，验证不泄漏到子进程 env（在 runTurn 前设置，严格验证白名单过滤）
    process.env.RPG4POV_TEST_LEAK = "should-not-leak";
    try {
      const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
      const runner = new ClaudeCodeRunner({ spawnFn: spawn });
      await runner.runTurn({
        storyId: meta.storyId,
        workspaceDir: resolveWorkspaceDir(meta.storyId),
        playerInput: "test",
        signal: AbortSignal.timeout(5000),
      });
      const env = calls[0].opts.env as Record<string, string | undefined>;
      expect(env.ANTHROPIC_API_KEY).toBe("sk-test-xxx");
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      expect(env.NODE_ENV).toBeDefined();
      // TMPDIR 在 Windows 上通常未定义（Windows 用 TEMP/TMP），故验证白名单传递而非存在性
      expect(env.TMPDIR).toBe(process.env.TMPDIR);
      expect(env.USE_BUILTIN_RIPGREP).toBe("0");
      // 白名单外的不应出现
      expect(env.RPG4POV_TEST_LEAK).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.RPG4POV_TEST_LEAK;
    }
  });

  it("prompt 经 stdin 传递（opts.stdinData），argv 不含完整 prompt 文本，也不含 prompt 文件路径", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    // stdinData 包含完整 prompt（含 playerInput）
    expect(calls[0].opts.stdinData).toContain("推开木门");
    // argv 不含完整 prompt 文本
    const args = calls[0].args as string[];
    expect(args.some((a) => a.includes("推开木门"))).toBe(false);
    // args 不含 prompt 文件路径（不再使用临时文件）
    expect(args.some((a) => a.includes("claude-prompts"))).toBe(false);
    // args 含 --settings/--permission-mode auto/--tools=Read,Write
    // （性能优化分支：路径规则在 2.1.140+网关环境对 Write 不匹配，default 全拒；
    //   改为工具集限制——Bash 对模型不存在，受保护文件由 orchestrator 基线守卫）
    expect(args).toContain("--settings");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
    expect(args).toContain("--tools=Read,Write");
  });

  it("stdinData 包含完整 prompt：playerInput、workspace 指令、history.jsonl 指令", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "走向酒馆",
      signal: AbortSignal.timeout(5000),
    });
    const stdinData = calls[0].opts.stdinData;
    // 完整 prompt 包含 playerInput
    expect(stdinData).toContain("走向酒馆");
    // 包含 workspace 读取指令
    expect(stdinData).toContain("story.md");
    expect(stdinData).toContain("world.md");
    expect(stdinData).toContain("player.md");
    // 包含 turns/history.jsonl 相关指令
    expect(stdinData).toContain("done.json");
  });

  it("成功回合返回 {success:true}，不写 stdout/stderr 到日志", async () => {
    const meta = await createStory();
    const { spawn } = makeMockSpawn({ code: 0, stdout: "claude stdout", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    expect(result.success).toBe(true);
    // 验证 logs/turn-errors.log 不存在（成功不写诊断）
    await expect(
      fs.access(path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log")),
    ).rejects.toThrow();
  });

  it("非零退出码返回 {success:false, error, detail}，detail 含脱敏信息", async () => {
    const meta = await createStory();
    const { spawn } = makeMockSpawn({
      code: 1,
      stdout: "ANTHROPIC_API_KEY=sk-leak-xxx some output",
      stderr: "error detail",
    });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // detail 包含脱敏后的诊断（runner 不再直接写日志，由 Orchestrator 写）
    expect(result.detail).toBeDefined();
    expect(result.detail).toContain("[REDACTED]");
    expect(result.detail).not.toContain("sk-leak-xxx");
  });

  it("abort signal 触发时 kill 子进程（SIGTERM），返回失败", async () => {
    const meta = await createStory();
    const killedSignals: string[] = [];
    const ctrl = new AbortController();
    const spawn: SpawnFn = (cmd, args, opts) => {
      return new Promise((resolve) => {
        // 模拟长耗时进程，监听 kill
        const fakeChild = {
          kill(sig: string) {
            killedSignals.push(sig);
          },
        };
        // 把 fakeChild 经 opts._child 暴露（测试 hack；真实 spawn 返回 ChildProcess）
        opts._child = fakeChild;
        // 立即 abort
        opts.signal?.addEventListener("abort", () => {
          resolve({ code: null, stdout: "", stderr: "", aborted: true });
        });
        // 确保 spawnFn 被调用（挂 _child、注册 listener）后再 abort，
        // 避免 abort 在 writeTempPrompt 期间触发导致 throwIfAborted 提前抛出
        setImmediate(() => ctrl.abort());
      });
    };
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: ctrl.signal,
    });
    expect(result.success).toBe(false);
    expect(killedSignals).toContain("SIGTERM");
  });

  it("spawnFn 抛普通异常（非 AbortError）返回 {success:false, error:'runner crashed', detail}", async () => {
    const meta = await createStory();
    // mock spawnFn 抛普通 Error，触发 catch 块的 "runner crashed" 路径
    const spawn: SpawnFn = () => Promise.reject(new Error("spawn ENOENT"));
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("runner crashed");
    // detail 包含异常信息（runner 不再直接写日志）
    expect(result.detail).toContain("spawn ENOENT");
  });
});

// --- init 三刀（P2 时间解剖优化）：骨架预注入 + done.json 看门狗 ---

describe("ClaudeCodeRunner init 三刀", () => {
  it("task=init 默认模板预注入骨架文件内容（story/world/player/rules 原文）", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "深夜酒馆设定",
      task: "init",
      signal: AbortSignal.timeout(5000),
    });
    expect(calls[0].opts.stdinData).toContain("已预注入的骨架文件");
    expect(calls[0].opts.stdinData).toContain("=== story.md ===");
    expect(calls[0].opts.stdinData).toContain("=== rules.md ===");
  });

  it("done.json 看门狗：新鲜 success done.json 落盘即 SIGTERM，非零退出码仍判成功", async () => {
    const meta = await createStory();
    let killed = false;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      await fs.mkdir(path.join(opts.cwd, "turn"), { recursive: true });
      await fs.writeFile(
        path.join(opts.cwd, "turn", "done.json"),
        JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
      );
      return await new Promise<SpawnResult>((resolve) => {
        opts._child = {
          kill: () => {
            killed = true;
            resolve({ code: 143, stdout: "", stderr: "" });
          },
        };
      });
    };
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "设定",
      task: "init",
      signal: AbortSignal.timeout(8000),
    });
    expect(result.success).toBe(true);
    expect(killed).toBe(true);
  });

  it("旧 done.json（mtime 不新于基线）不触发看门狗", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    await fs.mkdir(path.join(dir, "turn"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "turn", "done.json"),
      JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
    );
    let killed = false;
    const spawn: SpawnFn = async (_cmd, _args, opts) => {
      opts._child = { kill: () => { killed = true; } };
      await new Promise((r) => setTimeout(r, 500));
      return { code: 0, stdout: "", stderr: "" };
    };
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: dir,
      playerInput: "设定",
      task: "init",
      signal: AbortSignal.timeout(8000),
    });
    expect(result.success).toBe(true);
    expect(killed).toBe(false);
  });

  it("CLAUDE_EARLY_EXIT=0 关闭看门狗", async () => {
    const saved = process.env.CLAUDE_EARLY_EXIT;
    process.env.CLAUDE_EARLY_EXIT = "0";
    try {
      const meta = await createStory();
      let killed = false;
      const spawn: SpawnFn = async (_cmd, _args, opts) => {
        await fs.mkdir(path.join(opts.cwd, "turn"), { recursive: true });
        await fs.writeFile(
          path.join(opts.cwd, "turn", "done.json"),
          JSON.stringify({ status: "success", completedAt: new Date().toISOString() }),
        );
        opts._child = { kill: () => { killed = true; } };
        await new Promise((r) => setTimeout(r, 400));
        return { code: 0, stdout: "", stderr: "" };
      };
      const runner = new ClaudeCodeRunner({ spawnFn: spawn });
      const result = await runner.runTurn({
        storyId: meta.storyId,
        workspaceDir: resolveWorkspaceDir(meta.storyId),
        playerInput: "设定",
        task: "init",
        signal: AbortSignal.timeout(8000),
      });
      expect(result.success).toBe(true);
      expect(killed).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_EARLY_EXIT;
      else process.env.CLAUDE_EARLY_EXIT = saved;
    }
  });
});
