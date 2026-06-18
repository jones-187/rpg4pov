import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ClaudeCodeRunner, defaultSpawn } from "@/lib/claude-code-runner";
import type { SpawnFn, SpawnOpts } from "@/lib/claude-code-runner";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

const FAKE_CLAUDE = path.resolve(__dirname, "../fixtures/fake-claude.mjs");

let root: string;

beforeAll(async () => {
  root = await useTempWorkspaceRoot();
});

afterAll(() => resetWorkspaceRoot());

describe("ClaudeCodeRunner integration (fake-claude)", () => {
  it("success mode: fake-claude reads stdin prompt, writes output.md + done.json, runner returns {success:true}", async () => {
    const meta = await createStory({ title: "integration success" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as SpawnOpts);

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });

    expect(result.success).toBe(true);

    const outputMd = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(outputMd).toContain("主角视窗");

    const doneJson = JSON.parse(
      await fs.readFile(path.join(wsDir, "turn", "done.json"), "utf8"),
    );
    expect(doneJson.status).toBe("success");
  });

  it("fail mode: fake-claude exits 1, runner returns {success:false}, logs turn-errors.log", async () => {
    const meta = await createStory({ title: "integration fail" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], { ...opts, env: { ...opts.env, FAKE_CLAUDE_MODE: "fail" } } as SpawnOpts);

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });

    expect(result.success).toBe(false);
    // runner 不再直接写日志，detail 返回给 Orchestrator 在 restoreSnapshot 后写
    expect(result.detail).toBeDefined();
    expect(result.detail).toContain("exit=1");
  });

  it("missing-output mode: fake-claude only writes done.json, runner returns {success:true}", async () => {
    const meta = await createStory({ title: "integration missing-output" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], { ...opts, env: { ...opts.env, FAKE_CLAUDE_MODE: "missing-output" } } as SpawnOpts);

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "test",
      signal: AbortSignal.timeout(5000),
    });

    // Runner only checks exit code; missing output is Orchestrator's concern
    expect(result.success).toBe(true);

    // done.json exists
    const doneJson = JSON.parse(
      await fs.readFile(path.join(wsDir, "turn", "done.json"), "utf8"),
    );
    expect(doneJson.status).toBe("success");

    // output.md was NOT written by fake-claude (still the placeholder from createStory)
    const outputMd = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(outputMd).toContain("占位");
  });

  it("timeout mode: fake-claude hangs, AbortController aborts after 100ms, runner returns {success:false}", async () => {
    const meta = await createStory({ title: "integration timeout" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) => {
      // Mutate opts.env in-place so _child is set on the original opts object
      // that runTurn's abort handler reads
      opts.env = { ...opts.env, FAKE_CLAUDE_MODE: "timeout" };
      return defaultSpawn("node", [FAKE_CLAUDE, ...args], opts);
    };

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const ctrl = new AbortController();
    // Abort after 100ms
    setTimeout(() => ctrl.abort(), 100);

    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "test",
      signal: ctrl.signal,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("aborted");
  });

  it("assert-stdin mode: fake-claude verifies stdin contains playerInput, workspace directives, and history.jsonl directive", async () => {
    const meta = await createStory({ title: "integration assert-stdin" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], { ...opts, env: { ...opts.env, FAKE_CLAUDE_MODE: "assert-stdin" } } as SpawnOpts);

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });

    // assert-stdin 模式：stdin 包含完整 prompt，fake-claude 写 output + done，返回成功
    expect(result.success).toBe(true);

    const outputMd = await fs.readFile(path.join(wsDir, "turn", "output.md"), "utf8");
    expect(outputMd).toContain("主角视窗");

    const doneJson = JSON.parse(
      await fs.readFile(path.join(wsDir, "turn", "done.json"), "utf8"),
    );
    expect(doneJson.status).toBe("success");
  });

  it("stderr does not contain 'no stdin data received' warning", async () => {
    const meta = await createStory({ title: "integration no-stdin-warning" });
    const wsDir = resolveWorkspaceDir(meta.storyId);

    const wrappedSpawn: SpawnFn = (cmd, args, opts) =>
      defaultSpawn("node", [FAKE_CLAUDE, ...args], opts as SpawnOpts);

    const runner = new ClaudeCodeRunner({ spawnFn: wrappedSpawn });
    const result = await runner.runTurn({
      storyId: meta.storyId,
      workspaceDir: wsDir,
      playerInput: "推开木门",
      signal: AbortSignal.timeout(5000),
    });

    expect(result.success).toBe(true);
    // fake-claude 不会产生 "no stdin data received" 警告
    // 真实 claude CLI 也不应出现，因为 stdin 被立即写入并关闭
    expect(result.detail).toBeUndefined();
  });
});
