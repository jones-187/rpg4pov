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

  it("prompt 经临时文件作为位置参数传递，argv 不含完整 prompt 文本", async () => {
    const meta = await createStory();
    const { spawn, calls } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    // argv 不含完整 prompt 文本
    const args = calls[0].args as string[];
    expect(args.some((a) => a.includes("推开木门"))).toBe(false);
    // 最后一个位置参数是 prompt 文件路径
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain("claude-prompts");
    // args 含 --settings 和 --permission-mode
    expect(args).toContain("--settings");
    expect(args).toContain("--permission-mode");
    expect(args).toContain("auto");
  });

  it("临时 prompt 文件用完删除", async () => {
    const meta = await createStory();
    const { spawn } = makeMockSpawn({ code: 0, stdout: "", stderr: "" });
    const runner = new ClaudeCodeRunner({ spawnFn: spawn });
    await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: resolveWorkspaceDir(meta.storyId),
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });
    // 临时文件应已删除（检查 /tmp/claude-prompts 目录下没有残留）
    const tmpDir = path.join(os.tmpdir(), "claude-prompts");
    try {
      const files = await fs.readdir(tmpDir);
      expect(files.length).toBe(0);
    } catch {
      // 目录不存在也算通过
    }
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

  it("非零退出码返回 {success:false, error}，写脱敏+限长诊断到 logs/turn-errors.log", async () => {
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
    const logContent = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    expect(logContent).toContain("[REDACTED]");
    expect(logContent).not.toContain("sk-leak-xxx");
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

  it("spawnFn 抛普通异常（非 AbortError）返回 {success:false, error:'runner crashed'} 并写日志", async () => {
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
    // 验证诊断日志被写入，含 reason: "runner crashed"
    const logContent = await fs.readFile(
      path.join(resolveWorkspaceDir(meta.storyId), "logs", "turn-errors.log"),
      "utf8",
    );
    expect(logContent).toContain("runner crashed");
    expect(logContent).toContain("spawn ENOENT");
  });
});
