import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PiRunner } from "@/lib/pi-runner";
import type { SpawnFn, SpawnOpts } from "@/lib/claude-code-runner";
import { createStory, resolveWorkspaceDir } from "@/lib/workspace";
import { appendTurnHistory } from "@/lib/turn-history";
import { useTempWorkspaceRoot, resetWorkspaceRoot } from "../helpers/workspace-env";

/**
 * mock spawn：模拟 pi 的行为——files 非空则把文件写入 opts.cwd 后成功退出；
 * files 为 null 则什么都不写（模拟"口述不写盘"失效模式）。
 */
type CallRecord = { cmd: string; args: string[]; opts: SpawnOpts };
function makeSpawn(script: (null | Record<string, string>)[]): { spawn: SpawnFn; calls: CallRecord[] } {
  let i = 0;
  const calls: CallRecord[] = [];
  const spawn: SpawnFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const files = script[Math.min(i, script.length - 1)];
    i++;
    if (files) {
      for (const [file, content] of Object.entries(files)) {
        const target = path.join(opts.cwd, file);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content);
      }
    }
    return { code: 0, stdout: files ? "回合完成" : "（口述内容，未写盘）", stderr: "" };
  };
  return { spawn, calls };
}

const OUTPUT_MD = "# 主角视窗\n\n你推门进来，热气扑面。\n";
const INTERACTION_JSON = JSON.stringify({ mode: "decision", suggestions: ["应和一句"] });
const STATE_UPDATE_MD = [
  "=== FILE: world.md ===",
  "APPEND: ## 时间线",
  "REPLACE: （占位：场景、地点、时间与隐藏事实。后续初始化 agent 填充。）→ 雪夜客栈",
].join("\n");

const ENV_KEYS = ["PI_HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"] as const;
let savedEnv: Record<string, string | undefined>;
let piHome: string;

beforeEach(async () => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  piHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-home-"));
  process.env.PI_HOME = piHome;
  process.env.ANTHROPIC_BASE_URL = "http://gateway.test:3030";
  process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
  delete process.env.ANTHROPIC_MODEL;
  await useTempWorkspaceRoot();
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetWorkspaceRoot();
});

function turnRequest(storyId: string, workspaceDir: string) {
  return { storyId, workspaceDir, playerInput: "我下楼吃面", signal: AbortSignal.timeout(10_000) };
}

describe("PiRunner", () => {
  it("成功路径：合并 state-update、服务端写 done.json、只 spawn 一次", async () => {
    const meta = await createStory();
    await appendTurnHistory(meta.storyId, {
      turnId: "t0",
      at: new Date().toISOString(),
      input: "开场",
      output: "# 主角视窗\n开场白",
    });
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      {
        "turn/output.md": OUTPUT_MD,
        "turn/interaction.json": INTERACTION_JSON,
        "turn/state-update.md": STATE_UPDATE_MD,
      },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    // state-update 已合并进真实状态文件
    const world = await fs.readFile(path.join(dir, "world.md"), "utf8");
    expect(world).toContain("雪夜客栈");
    expect(world).not.toContain("占位");
    // done.json 由服务端写入
    const done = JSON.parse(await fs.readFile(path.join(dir, "turn", "done.json"), "utf8"));
    expect(done.status).toBe("success");
    // pi 配置已生成
    const modelsJson = JSON.parse(await fs.readFile(path.join(piHome, "agent", "models.json"), "utf8"));
    expect(modelsJson.providers.newapi.models[0].id).toBe("qwen-fp8");
  });

  it("首次口述不写盘时自动重试一次", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      null,
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(await fs.readFile(path.join(dir, "turn", "output.md"), "utf8")).toBe(OUTPUT_MD);
  });

  it("两次都没写盘 → 失败，错误信息含 attempt 诊断", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([null]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(false);
    expect(result.error).toContain("no turn output");
    expect(result.detail).toContain("attempt 1");
    expect(calls).toHaveLength(2);
    // done.json 不应存在（无成功标记）
    await expect(fs.access(path.join(dir, "turn", "done.json"))).rejects.toThrow();
  });

  it("state-update.md 缺失时降级成功（无状态合并）", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn } = makeSpawn([{ "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON }]);
    const runner = new PiRunner({ spawnFn: spawn });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("state-update.md missing");
  });

  it("argv 正确：-p/--no-session/--model qwen-fp8，尾参含预注入上下文与玩家输入", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const { spawn, calls } = makeSpawn([
      { "turn/output.md": OUTPUT_MD, "turn/interaction.json": INTERACTION_JSON },
    ]);
    const runner = new PiRunner({ spawnFn: spawn });
    await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(calls[0].cmd).toBe("pi");
    expect(calls[0].args).toContain("-p");
    expect(calls[0].args).toContain("--no-session");
    expect(calls[0].args).toContain("qwen-fp8");
    const userPrompt = calls[0].args[calls[0].args.length - 1];
    expect(userPrompt).toContain("=== world.md ===");
    expect(userPrompt).toContain("=== turns/history.jsonl");
    expect(userPrompt).toContain("我下楼吃面");
    expect(calls[0].opts.cwd).toBe(dir);
  });

  it("随机判定：池注入 prompt，申报经服务端权威重算落账 random-rolls.jsonl", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== FILE: world.md ===",
        "APPEND: ## 时间线",
        "=== RANDOM ===",
        "R1: rollId=lockpick candidates=success:25,fail:75 → fail",
      ].join("\n"),
    };
    const { spawn, calls } = makeSpawn([files]);
    // 0.9×100=90 落在 fail(25-100) 区间 → 权威结果 fail，与申报一致
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.9 });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    const userPrompt = calls[0].args[calls[0].args.length - 1];
    expect(userPrompt).toContain("=== 随机数池");
    expect(userPrompt).toContain("R1=0.900000");
    expect(userPrompt).toContain("R6="); // 默认池 6 个样本

    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(line).toMatchObject({
      storyId: meta.storyId,
      rollId: "lockpick",
      type: "roll-choice",
      selectedId: "fail",
      randomSource: "pool",
      sample: 0.9,
    });
  });

  it("申报结果与权威重算不一致：回合仍成功，detail 记 mismatch", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== RANDOM ===",
        "R1: rollId=persuade candidates=yes:50,no:50 → yes",
      ].join("\n"),
    };
    const { spawn } = makeSpawn([files]);
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.9 }); // 0.9×100=90 → no

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("declared yes but authoritative no");
    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const line = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(line.selectedId).toBe("no"); // 落账以服务端重算为准
  });

  it("乱序申报跳过且不消耗号位；后续按序申报仍可落账", async () => {
    const meta = await createStory();
    const dir = resolveWorkspaceDir(meta.storyId);
    const files = {
      "turn/output.md": OUTPUT_MD,
      "turn/interaction.json": INTERACTION_JSON,
      "turn/state-update.md": [
        "=== RANDOM ===",
        "R2: rollId=jumped candidates=x:1 → x",
        "R1: rollId=first candidates=x:1 → x",
      ].join("\n"),
    };
    const { spawn } = makeSpawn([files]);
    const runner = new PiRunner({ spawnFn: spawn, rollRng: () => 0.5 });

    const result = await runner.runTurn(turnRequest(meta.storyId, dir));

    expect(result.success).toBe(true);
    expect(result.detail).toContain("roll skipped (out of order): R2, expected R1");
    // 乱序 R2 未消耗号位，R1 仍按序落账
    const raw = await fs.readFile(path.join(dir, "logs", "random-rolls.jsonl"), "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ rollId: "first", sample: 0.5 });
  });
});
